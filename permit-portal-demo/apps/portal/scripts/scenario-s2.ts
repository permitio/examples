// S2 end to end, in ten checks: Sam, the organization admin, gives Merry mixed access across
// EANs, a child account and depots, only as far as Permit lets Sam grant it, and Frodo, admin of EAN-1001 alone, is held to
// that EAN's subtree. The runner resets the demo (reset.ts, which ends with preflight) and waits until the PDP shows the
// reset state. Then it drives the portal's API as each persona, and the console's forged-grant tester of Great Eagle's
// systems, asserting every decision, every status code and what the decision panel records. It is the automated rehearsal.
// Run: bin/demo scenario <profile> s2. Exit 0 pass, 1 fail, 2 could not run.
import { TENANT } from '../src/server/model';
import { type ScriptEnv, scriptEnv } from './lib/env';
import { isMain, type Outcome, type Result, runCli } from './lib/report';
import { runReset } from './reset';
import {
  Api, awaitResetState, type Expected, eventsSince, expectDecisions, expectEqual, expectSameItems, field, lastEventId, listOf, type Log, ms,
  numberOf, runScenario, type StepContext, StepError, textOf, textsOf,
} from './scenario-runner';

const SAM = 'sam';
const FRODO = 'frodo';
const MERRY = 'merry';

const EAN_1001 = 'ean:EAN-1001';
const EAN_1002 = 'ean:EAN-1002';
const HOBBITON = 'account:CA-1001-A';
const BYWATER = 'account:CA-1001-B';
const MICHEL_DELVING = 'account:CA-1002-A';
const BAG_END = 'location:LOC-BAGEND';
const BYWATER_DEPOT = 'location:LOC-BYWATER';
const FROGMORTON_DEPOT = 'location:LOC-FROGMORTON';
const MICHEL_DEPOT = 'location:LOC-MICHEL';

/** A role on a place, as Team access lists and grants it: `role resource`, the resource as `type:key`. */
const pair = (role: string, resource: string) => `${role} ${resource}`;

/** What Team access offers Sam: every role on every place in Shire Freight, and never the integration sandbox or an EAN not in Permit. */
const SAMS_TEAM = [
  ...[EAN_1001, EAN_1002].map((place) => pair('shipper', place)),
  ...[EAN_1001, EAN_1002].map((place) => pair('account_admin', place)),
  ...[HOBBITON, BYWATER, MICHEL_DELVING].map((place) => pair('account_manager', place)),
  ...[BAG_END, BYWATER_DEPOT, FROGMORTON_DEPOT, MICHEL_DEPOT].map((place) => pair('location_operator', place)),
];
/** What it offers Frodo: EAN-1001 and what sits under it, and no account admin: nobody below the org admin makes an EAN admin. */
const FRODOS_TEAM = [
  pair('shipper', EAN_1001),
  ...[HOBBITON, BYWATER].map((place) => pair('account_manager', place)),
  ...[BAG_END, BYWATER_DEPOT, FROGMORTON_DEPOT].map((place) => pair('location_operator', place)),
];

/** The roles Sam gives Merry in steps 2 to 4: shipper on both EANs, manager of Bywater, operator of two depots. */
const MERRYS_ROLES = [
  pair('shipper', EAN_1001), pair('shipper', EAN_1002), pair('account_manager', BYWATER),
  pair('location_operator', BYWATER_DEPOT), pair('location_operator', FROGMORTON_DEPOT),
];

/** The wording the portal gives a refusal (`deniedBy`), which the console shows verbatim. */
const FORGED_REFUSAL = 'Permit denied grant_shipper on ean:EAN-1002.';

const shire = (user: string, action: string, place: string, expect: boolean): Expected => {
  const [type = '', key = ''] = place.split(':');
  return { user, action, type, key, tenant: TENANT.shire, expect };
};

/** The reset state as the PDP must see it before step 1: Merry holds no role on any place, and Frodo still administers EAN-1001. */
const RESET_STATE: Expected[] = [
  shire(MERRY, 'view', EAN_1001, false), shire(MERRY, 'view', EAN_1002, false), shire(MERRY, 'view_billing', BYWATER, false),
  shire(MERRY, 'operate', BYWATER_DEPOT, false), shire(FRODO, 'grant_shipper', EAN_1001, true),
];

/** One row of Merry's "What I can do" grid. */
interface Row { resource: string; name: string; roles: string[]; actions: string[] }

/** Merry's grid, read as Merry: the only persona it answers for. */
async function gridOf(portal: Api): Promise<Row[]> {
  const rows = listOf(await portal.expect(200, 'GET', `/api/s2/permissions/${MERRY}`, { persona: MERRY }), 'rows');
  return rows.map((row) => ({ resource: textOf(row, 'resource'), name: textOf(row, 'name'), roles: textsOf(row, 'roles'), actions: textsOf(row, 'actions') }));
}

/** The row of `resource`, held to the roles and actions it must list. */
function expectRow(grid: readonly Row[], resource: string, roles: string[], actions: string[]): Row {
  const row = grid.find((candidate) => candidate.resource === resource);
  if (row === undefined) throw new StepError(`Merry's grid has no row for ${resource}; it lists ${grid.map((r) => r.resource).join(', ') || 'nothing'}`);
  expectSameItems(`Merry's roles on ${resource}`, row.roles, roles);
  expectSameItems(`Merry's actions on ${resource}`, row.actions, actions);
  return row;
}

/** The roles of Merry that `persona` may see in Team access, as `role resource`. */
async function assignmentsOf(portal: Api, persona: string): Promise<string[]> {
  const body = await portal.expect(200, 'GET', `/api/s2/members/${MERRY}/assignments`, { persona });
  return listOf(body, 'assignments').map((a) => pair(textOf(a, 'role'), textOf(a, 'resource')));
}

/** The pairs of Team access that `persona` is offered, and the people it lists. */
async function teamOf(portal: Api, persona: string): Promise<{ members: string[]; grantable: string[] }> {
  const team = await portal.expect(200, 'GET', '/api/s2/team', { persona });
  return { members: listOf(team, 'members').map((m) => textOf(m, 'key')), grantable: listOf(team, 'grantable').map((g) => pair(textOf(g, 'role'), textOf(g, 'resource'))) };
}

/**
 * Sam gives Merry `role` on `resource`: 201 with a write the PDP confirmed (ms above 0), and the decision panel shows
 * Permit's `grant_<role>` check as Sam first and the confirmed write after it.
 */
async function grant(s: StepContext, portal: Api, role: string, resource: string): Promise<void> {
  const since = await lastEventId(portal);
  const confirmed = numberOf(await portal.expect(201, 'POST', '/api/s2/grants', { persona: SAM, body: { user: MERRY, role, resource } }), 'ms');
  if (!(confirmed > 0)) throw new StepError(`the grant of ${role} on ${resource} reports ${confirmed} ms on the PDP, so no change was applied`);
  const feed = await eventsSince(portal, since);
  const check = feed.find((e) => e.kind === 'check' && e.user === SAM && e.action === `grant_${role}` && e.resource === resource);
  const write = feed.find((e) => e.kind === 'write' && e.what === `assign ${role} on ${resource} to ${MERRY}`);
  if (check?.kind !== 'check' || !check.allow) throw new StepError(`the decision panel has no allowed grant_${role} check as ${SAM} on ${resource}`);
  if (write?.kind !== 'write' || !write.ok) throw new StepError(`the decision panel has no confirmed write "assign ${role} on ${resource} to ${MERRY}"`);
  if (check.id > write.id) throw new StepError(`the grant of ${role} on ${resource} was written before Permit was asked`);
  s.note(`Sam gave Merry ${role} on ${resource}: Permit allowed grant_${role}, then the write was confirmed on the local PDP in ${ms(confirmed)}`);
}

export interface S2Options {
  /** Puts the demo in its starting state first: runReset, or a stand-in in tests. */
  reset: () => Promise<Outcome>;
  log?: Log;
}

export async function runS2(env: Pick<ScriptEnv, 'profile' | 'portalUrl' | 'greatEagleSystemsUrl'>, opts: S2Options): Promise<Result> {
  const log = opts.log ?? console.log;
  const portal = new Api('portal', env.portalUrl);
  const mock = new Api('Great Eagle systems mock', env.greatEagleSystemsUrl);
  log(`S2 on profile ${env.profile}: portal ${env.portalUrl}, Great Eagle systems ${env.greatEagleSystemsUrl}`);
  return runScenario({ title: `S2 on ${env.profile}`, profile: env.profile, portal, reset: opts.reset, log }, async (run) => {
    await awaitResetState(run, portal, RESET_STATE);

    await run.step("Sam's team lists every grantable pair", async (s) => {
      const team = await teamOf(portal, SAM);
      if (!team.members.includes(MERRY)) throw new StepError(`Sam's team does not list Merry among ${team.members.join(', ')}`);
      expectSameItems("Sam's Team access", team.grantable, SAMS_TEAM);
      s.note(`Sam may grant ${team.grantable.length} pairs: shipper and account admin on 2 EANs, account manager on 3 child accounts, location operator on 4 depots`);
      s.note('the integration sandbox is not among them');
    });

    await run.step('Sam grants shipper on EAN-1001 and EAN-1002', async (s) => {
      await grant(s, portal, 'shipper', EAN_1001);
      await grant(s, portal, 'shipper', EAN_1002);
    });

    await run.step('Sam grants account manager on Bywater', (s) => grant(s, portal, 'account_manager', BYWATER));

    await run.step('Sam grants location operator on two depots', async (s) => {
      await grant(s, portal, 'location_operator', BYWATER_DEPOT);
      await grant(s, portal, 'location_operator', FROGMORTON_DEPOT);
      expectSameItems("Merry's roles in Sam's Team access", await assignmentsOf(portal, SAM), MERRYS_ROLES);
      s.note(`Merry now holds ${MERRYS_ROLES.length} roles; Bag End depot is not one of them`);
    });

    await run.step('A repeated grant changes nothing', async (s) => {
      const since = await lastEventId(portal);
      // Permit holds a repeated assignment once and answers success, not 409, so the portal re-confirms it: no error, and no change.
      const repeat = numberOf(await portal.expect(201, 'POST', '/api/s2/grants', { persona: SAM, body: { user: MERRY, role: 'shipper', resource: EAN_1001 } }), 'ms');
      expectSameItems("Merry's roles after the repeat", await assignmentsOf(portal, SAM), MERRYS_ROLES);
      const writes = (await eventsSince(portal, since)).filter((e) => e.kind === 'write');
      s.note(`the same grant again answered 201 in ${ms(repeat)} (${writes.length === 1 ? 'one confirming write' : `${writes.length} writes`}); Merry still holds ${MERRYS_ROLES.length} roles, none twice`);
    });

    await run.step("Merry's grid: Hobbiton and Bywater", async (s) => {
      const grid = await gridOf(portal);
      expectRow(grid, EAN_1001, ['shipper'], ['view', 'ship']);
      expectRow(grid, EAN_1002, ['shipper'], ['view', 'ship']);
      const hobbiton = expectRow(grid, HOBBITON, ['shipper'], ['view', 'ship']);
      const bywater = expectRow(grid, BYWATER, ['shipper', 'account_manager'], ['view', 'ship', 'view_billing']);
      expectRow(grid, MICHEL_DELVING, ['shipper'], ['view', 'ship']);
      s.note(`${hobbiton.name} lists view and ship, derived from shipper on EAN-1001 (Merry was never assigned there)`);
      s.note(`${bywater.name} adds view_billing, from account manager`);
      // The PDP's own answers agree with the grid: it is not a list the portal made up.
      await expectDecisions(s, portal, [
        shire(MERRY, 'ship', HOBBITON, true), shire(MERRY, 'view_billing', HOBBITON, false),
        shire(MERRY, 'view_billing', BYWATER, true), shire(MERRY, 'view_billing', MICHEL_DELVING, false),
      ]);
    });

    await run.step("Merry's grid: the depots", async (s) => {
      const grid = await gridOf(portal);
      expectRow(grid, BYWATER_DEPOT, ['location_operator'], ['view', 'operate']);
      expectRow(grid, FROGMORTON_DEPOT, ['location_operator'], ['view', 'operate']);
      // Nothing else is listed: no row for Bag End or Michel Delving's depot, and no stray row of another kind.
      expectSameItems("Merry's grid", grid.map((row) => row.resource), [EAN_1001, EAN_1002, HOBBITON, BYWATER, MICHEL_DELVING, BYWATER_DEPOT, FROGMORTON_DEPOT]);
      s.note('Bywater depot and Frogmorton depot list operate; Bag End depot has no row at all');
      await expectDecisions(s, portal, [
        shire(MERRY, 'operate', BYWATER_DEPOT, true), shire(MERRY, 'operate', FROGMORTON_DEPOT, true),
        shire(MERRY, 'operate', BAG_END, false), shire(MERRY, 'view', BAG_END, false),
      ]);
    });

    await run.step("Frodo's team stops at EAN-1001", async (s) => {
      const team = await teamOf(portal, FRODO);
      expectSameItems("Frodo's Team access", team.grantable, FRODOS_TEAM);
      s.note(`Frodo may grant ${team.grantable.length} pairs, all on EAN-1001 or under it, and none is account admin`);
      // The read keeps the scope too: Frodo sees Merry's roles inside EAN-1001 and not Merry's shipper role on EAN-1002.
      expectSameItems("Merry's roles in Frodo's Team access", await assignmentsOf(portal, FRODO), MERRYS_ROLES.filter((role) => role !== pair('shipper', EAN_1002)));
      s.note("Frodo does not see Merry's shipper role on EAN-1002");
      await expectDecisions(s, portal, [
        shire(FRODO, 'grant_shipper', EAN_1001, true), shire(FRODO, 'grant_shipper', EAN_1002, false),
        shire(FRODO, 'grant_account_admin', EAN_1001, false), shire(FRODO, 'grant_location_operator', MICHEL_DEPOT, false),
      ]);
    });

    await run.step("Frodo's forged grant is refused", async (s) => {
      const since = await lastEventId(portal);
      const before = await assignmentsOf(portal, SAM);
      // The console's API tester sends Frodo's grant of shipper on EAN-1002, which the form never offers, straight to the portal.
      const answer = await mock.expect(200, 'POST', '/api/s2/forged-grant');
      expectEqual("the portal's status for the forged grant", numberOf(answer, 'status'), 403);
      const refusal = field(answer, 'body');
      expectEqual("the portal's reason", textOf(refusal, 'error'), FORGED_REFUSAL);
      expectEqual('the decision', field(refusal, 'decision'), 'deny');
      const feed = await eventsSince(portal, since);
      const check = feed.find((e) => e.kind === 'check' && e.user === FRODO && e.action === 'grant_shipper' && e.resource === EAN_1002);
      if (check?.kind !== 'check' || check.allow) throw new StepError(`the decision panel has no DENIED grant_shipper check as ${FRODO} on ${EAN_1002}`);
      const writes = feed.filter((e) => e.kind === 'write');
      if (writes.length > 0) throw new StepError(`the refused grant still wrote to Permit: ${writes.map((e) => (e.kind === 'write' ? e.what : '')).join('; ')}`);
      expectSameItems("Merry's roles after the forged grant", await assignmentsOf(portal, SAM), before);
      s.note(`403 "${FORGED_REFUSAL}" and no write; the decision panel shows the DENIED check`);
    });

    await run.step("Removing a grant shows in Merry's grid", async (s) => {
      const since = await lastEventId(portal);
      const revoke = { user: MERRY, role: 'location_operator', resource: FROGMORTON_DEPOT };
      const removed = numberOf(await portal.expect(200, 'DELETE', '/api/s2/grants', { persona: SAM, body: revoke }), 'ms');
      if (!(removed > 0)) throw new StepError(`the removal reports ${removed} ms on the PDP, so no change was applied`);
      const feed = await eventsSince(portal, since);
      const check = feed.find((e) => e.kind === 'check' && e.user === SAM && e.action === 'grant_location_operator' && e.resource === FROGMORTON_DEPOT);
      const write = feed.find((e) => e.kind === 'write' && e.what === `unassign location_operator on ${FROGMORTON_DEPOT} from ${MERRY}`);
      if (check?.kind !== 'check' || !check.allow) throw new StepError(`the decision panel has no allowed grant_location_operator check as ${SAM} on ${FROGMORTON_DEPOT}`);
      if (write?.kind !== 'write' || !write.ok) throw new StepError(`the decision panel has no confirmed write "unassign location_operator on ${FROGMORTON_DEPOT} from ${MERRY}"`);
      s.note(`Sam removed Merry's operator role on Frogmorton depot: Permit allowed it, and the change was confirmed on the local PDP in ${ms(removed)}`);
      const grid = await gridOf(portal);
      expectSameItems("Merry's grid after the removal", grid.map((row) => row.resource), [EAN_1001, EAN_1002, HOBBITON, BYWATER, MICHEL_DELVING, BYWATER_DEPOT]);
      expectRow(grid, BYWATER_DEPOT, ['location_operator'], ['view', 'operate']);
      s.note('Frogmorton depot is gone from the grid; Bywater depot stays');
      // Removing it again is a no-op: Permit answers 404, which the portal reads as done.
      const again = await portal.expect(200, 'DELETE', '/api/s2/grants', { persona: SAM, body: revoke });
      expectEqual('the milliseconds a repeated removal reports', numberOf(again, 'ms'), 0);
      s.note('removing it again answers 200 with ms 0: nothing was left to remove');
    });
  });
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const env = scriptEnv();
    return runS2(env, { reset: () => runReset(env) });
  });
}
