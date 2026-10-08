// S8 end to end: a legacy billing app of Great Eagle's systems, with its own users table, adopts Permit next to its
// own logic. The runner resets the demo (reset.ts, which ends with preflight) and waits until the PDP shows the reset state.
// Then it validates the first mapping (3 groups of mismatches, 2 of them approved), fixes the mapping and syncs it (0
// unexpected), moves the legacy app from shadow to both, has Sam revoke Frodo through S2's API (the legacy app denies Frodo
// at once, with its table untouched), cuts over to Permit and rolls back, and finally replays the run's decisions from
// Permit's audit log against today's policy: the revocation shows up as a changed decision. It is the automated rehearsal.
// Run: bin/demo scenario <profile> s8. Exit 0 pass, 1 fail, 2 could not run.
import { TENANT } from '../src/server/model';
import { describeError, scriptPermit } from './lib/admin';
import { type ScriptEnv, scriptEnv } from './lib/env';
import { pollUntil } from './lib/pdp';
import { isMain, type Outcome, type Result, runCli } from './lib/report';
import { type ReplayDeps, type ReplayReport, permitGet, replayAuditLog, scopeOf } from './replay';
import { runReset } from './reset';
import {
  Api, awaitResetState, booleanOf, type Expected, expectEqual, expectDecisions, expectSameItems, field, listOf, type Log, ms, numberOf, runScenario, seconds,
  ServiceUnreachable, type StepContext, StepError, textOf,
} from './scenario-runner';

const SAM = 'sam';
const FRODO = 'frodo';
const PIPPIN = 'pippin';
const FATTY = 'fatty';
const LOBELIA = 'lobelia';
const HOBBITON = 'CA-1001-A';
const BYWATER = 'CA-1001-B';
const MICHEL_DELVING = 'CA-1002-A';
/** The legacy app's one protected action: the one the audit log is read and replayed for. */
const VIEW_BILLING = 'view_billing';
/** Frodo's account admin role, which Sam removes in Team access (R2: an EAN admin is a grantable role). */
const FRODOS_ROLE = { user: FRODO, role: 'account_admin', resource: 'ean:EAN-1001' };
/** Permit's audit log is written in batches by the PDP, and listed some seconds after the decisions: measured at about 9 s. */
const AUDIT_WAIT_MS = 120_000;
const AUDIT_POLL_MS = 2_000;

const word = (answer: boolean | null) => (answer === null ? 'could not check' : answer ? 'allow' : 'deny');

/** One legacy request, as the legacy app answers it: its own rule, Permit's answer (null when Permit gave none), what it enforced and in which mode. */
interface Answer { legacy: boolean; permit: boolean | null; enforced: boolean; mode: string }

async function requestAs(mock: Api, user: string, account: string): Promise<Answer> {
  const answer = await mock.expect(200, 'POST', '/api/legacy/requests', { body: { user, account } });
  const permit = field(answer, 'permit');
  if (permit !== null && typeof permit !== 'boolean') throw new StepError(`expected true, false or null in "permit", got ${String(permit)}`);
  return { legacy: booleanOf(answer, 'legacy'), permit, enforced: booleanOf(answer, 'enforced'), mode: textOf(answer, 'mode') };
}

/** Asks as `user` for `account` and holds the answer to what each side must say. Permit's silence (null) is none of true or false. */
async function expectRequest(
  s: StepContext, mock: Api, user: string, account: string, mode: string, want: { legacy: boolean; permit: boolean; enforced: boolean },
): Promise<void> {
  const who = `${user} on ${account}`;
  const answer = await requestAs(mock, user, account);
  expectEqual(`${who}: the mode`, answer.mode, mode);
  expectEqual(`${who}: the legacy app's own answer`, answer.legacy, want.legacy);
  expectEqual(`${who}: Permit's answer`, answer.permit, want.permit);
  expectEqual(`${who}: what the legacy app enforced`, answer.enforced, want.enforced);
  s.note(`${who}: legacy ${word(answer.legacy)}, Permit ${word(answer.permit)}, enforced ${word(answer.enforced)} (${mode})`);
}

/** One group of mismatches in the comparison: a user, how many, and the owner's approval when the tightening is expected. */
interface Group { user: string; count: number; expected?: { reason: string; approvedBy: string } }

/** The legacy app's comparison of its own rule and Permit's, over its recorded access log. A run Permit could not answer proves nothing: it fails. */
async function validate(mock: Api): Promise<{ total: number; mismatches: number; groups: Group[] }> {
  const answer = await mock.expect(200, 'POST', '/api/legacy/validate');
  const summary = field(answer, 'summary');
  const total = numberOf(summary, 'total');
  const unanswered = numberOf(summary, 'could_not_check');
  if (unanswered > 0) {
    const reason = field(answer, 'error');
    throw new StepError(`Permit could not check ${unanswered} of ${total} requests${typeof reason === 'string' ? `: ${reason}` : ''}`);
  }
  const groups = listOf(summary, 'groups').map((group): Group => {
    const approval = field(group, 'expected');
    return {
      user: textOf(group, 'user'), count: numberOf(group, 'count'),
      ...(approval === undefined ? {} : { expected: { reason: textOf(approval, 'reason'), approvedBy: textOf(approval, 'approved_by') } }),
    };
  });
  return { total, mismatches: numberOf(summary, 'mismatches'), groups };
}

/** The mismatches that nobody approved: the ones the owner has to look at. */
const unexpectedOf = (groups: readonly Group[]) => groups.filter((group) => group.expected === undefined);

/** The groups' lines for the notes: the user, how many, and why it is expected or not. */
function describeGroup(group: Group): string {
  return `${group.user}: ${group.count} requests, ${group.expected ? `expected tightening "${group.expected.reason}", approved by ${group.expected.approvedBy}` : 'unexpected'}`;
}

const onAccount = (user: string, account: string, expect: boolean): Expected => ({ user, action: VIEW_BILLING, type: 'account', key: account, tenant: TENANT.shire, expect });

/** The reset state as the PDP must see it before step 1: Frodo and Sam may view billing on Hobbiton, and Pippin may not until the mapping is fixed. */
const RESET_STATE: Expected[] = [onAccount(FRODO, HOBBITON, true), onAccount(SAM, HOBBITON, true), onAccount(PIPPIN, HOBBITON, false)];

/** What the run needs of Permit's audit log: to know when it lists the run, and to ask its decisions again. */
export interface AuditTrail {
  /** Whether the audit log lists a view_billing decision of `user` made at or after `since` (ms). Reads only. A failed read throws. */
  audited: (user: string, since: number) => Promise<boolean>;
  /** The view_billing decisions the audit log lists in the window, asked again against today's policy and data. */
  replay: (window: { since: number; until: number }) => Promise<ReplayReport>;
}

/** The audit trail over Permit's audit-log API and the local PDP, the same reads and bulk checks as `bin/demo replay`. */
export function auditTrailWith(deps: Pick<ReplayDeps, 'get' | 'bulkCheck'>, now: () => number = Date.now): AuditTrail {
  let scope: { project: string; environment: string } | undefined;
  const scoped = async () => (scope ??= await scopeOf(deps.get));
  return {
    async audited(user, since) {
      const { project, environment } = await scoped();
      // Both ends of the window: the audit-log search applies a time range only when it gets both.
      const query = new URLSearchParams({
        users: user, action: VIEW_BILLING, timestamp_from: String(Math.floor(since / 1000)), timestamp_to: String(Math.ceil(now() / 1000) + 1), page: '1', per_page: '1',
      });
      const page = await deps.get(`/v2/pdps/${encodeURIComponent(project)}/${encodeURIComponent(environment)}/audit_logs?${query}`);
      const data = typeof page === 'object' && page !== null ? (page as { data?: unknown }).data : undefined;
      if (!Array.isArray(data)) throw new Error('The audit-log API answered something other than a page of decisions');
      return data.length > 0;
    },
    async replay(window) {
      const { project, environment } = await scoped();
      return replayAuditLog(deps, { project, environment, ...window, action: VIEW_BILLING });
    },
  };
}

export const auditTrailOf = (env: ScriptEnv): AuditTrail =>
  auditTrailWith({ get: permitGet(env), bulkCheck: (checks) => scriptPermit(env).bulkCheck(checks) });

export interface S8Options extends AuditTrail {
  /** Puts the demo in its starting state first: runReset, or a stand-in in tests. */
  reset: () => Promise<Outcome>;
  /** How long step 10 waits for the audit log to list the run, and how often it asks. */
  auditWaitMs?: number;
  auditPollMs?: number;
  log?: Log;
}

export async function runS8(env: Pick<ScriptEnv, 'profile' | 'portalUrl' | 'greatEagleSystemsUrl'>, opts: S8Options): Promise<Result> {
  const log = opts.log ?? console.log;
  const portal = new Api('portal', env.portalUrl);
  const mock = new Api('Great Eagle systems mock', env.greatEagleSystemsUrl);
  log(`S8 on profile ${env.profile}: portal ${env.portalUrl}, Great Eagle systems ${env.greatEagleSystemsUrl}`);
  return runScenario({ title: `S8 on ${env.profile}`, profile: env.profile, portal, reset: opts.reset, log }, async (run) => {
    await awaitResetState(run, portal, RESET_STATE);
    // The run's own window in the audit log, from just before its first decision. The log stamps whole seconds.
    const began = Date.now() - 1_000;
    let revokedAt = 0;

    await run.step('Shadow mode by default', async (s) => {
      const state = await mock.expect(200, 'GET', '/api/legacy/state');
      expectEqual('the mode', textOf(state, 'mode'), 'shadow');
      expectEqual('the mapping version', numberOf(state, 'mappingVersion'), 1);
      expectEqual('the validations run', numberOf(state, 'validations'), 0);
      expectSameItems("the legacy app's users", listOf(state, 'users').map((u) => textOf(u, 'key')), [SAM, FRODO, PIPPIN, FATTY, LOBELIA]);
      s.note('shadow mode, mapping version 1, five users in the legacy table: the legacy rule decides and Permit is only recorded');
      await expectRequest(s, mock, FRODO, HOBBITON, 'shadow', { legacy: true, permit: true, enforced: true });
      // The mapping does not translate Pippin's child-account code yet: Permit says no, and the legacy answer is the one enforced.
      await expectRequest(s, mock, PIPPIN, HOBBITON, 'shadow', { legacy: true, permit: false, enforced: true });
    });

    await run.step('Validate mapping v1', async (s) => {
      const { total, mismatches, groups } = await validate(mock);
      expectSameItems('the users with mismatches', groups.map((g) => g.user), [PIPPIN, FATTY, LOBELIA]);
      for (const user of [FATTY, LOBELIA]) {
        const group = groups.find((g) => g.user === user);
        expectEqual(`the owner's approval of ${user}'s tightening`, group?.expected?.approvedBy, SAM);
      }
      expectEqual("Pippin's mismatches are unexpected: approved by", groups.find((g) => g.user === PIPPIN)?.expected?.approvedBy, undefined);
      s.note(`${mismatches} of ${total} logged requests differ between the legacy rule and Permit, in ${groups.length} groups, ${groups.length - unexpectedOf(groups).length} of them expected`);
      for (const group of groups) s.note(describeGroup(group));
      s.note("Pippin's mismatch is the mapping's bug: a child-account code (CA-1001-A) is not translated in version 1");
    });

    await run.step('Mapping v2 and sync', async (s) => {
      expectEqual('the mapping version', numberOf(await mock.expect(200, 'PUT', '/api/legacy/mapping', { body: { version: 2 } }), 'mappingVersion'), 2);
      const sync = await mock.expect(200, 'POST', '/api/legacy/sync');
      expectEqual('the mapping version synced', numberOf(sync, 'version'), 2);
      const grants = listOf(sync, 'grants').map((grant) => ({
        user: textOf(grant, 'user'), role: textOf(grant, 'role'), resource: field(grant, 'resource'), status: textOf(grant, 'status'),
      }));
      expectSameItems('the grants the mapping skipped', grants.filter((g) => g.status === 'skipped').map((g) => g.user), [LOBELIA, LOBELIA]);
      expectEqual('the grants that failed', grants.filter((g) => g.status === 'failed').length, 0);
      // A grant Permit holds already is read as such and counts as unchanged (after a reset, Sam's and Frodo's), the rest as
      // written: together they are every grant but Lobelia's two. Either split passes, so a sync that wrote again would too.
      expectEqual('the grants written or already held', numberOf(sync, 'written') + numberOf(sync, 'unchanged'), grants.length - 2);
      const pippin = grants.find((g) => g.user === PIPPIN);
      expectEqual("Pippin's grant", pippin && `${pippin.role} on ${String(pippin.resource)}`, `account_manager on account:${HOBBITON}`);
      expectEqual("what the sync did with Pippin's grant", pippin?.status, 'written');
      s.note(`mapping version 2, synced: ${numberOf(sync, 'written')} written, ${numberOf(sync, 'unchanged')} already held, ${numberOf(sync, 'skipped')} skipped (${LOBELIA} is not in Permit's directory)`);
      s.note(`Pippin gets account_manager on account:${HOBBITON}, written through the PDP and confirmed`);
      await expectDecisions(s, portal, [onAccount(PIPPIN, HOBBITON, true)]);
    });

    await run.step('Validate again: 0 unexpected', async (s) => {
      const { total, mismatches, groups } = await validate(mock);
      expectSameItems('the users with mismatches', groups.map((g) => g.user), [FATTY, LOBELIA]);
      expectEqual('the unexpected mismatches', unexpectedOf(groups).length, 0);
      s.note(`${mismatches} of ${total} logged requests still differ, all of them expected tightenings: 0 unexpected`);
      for (const group of groups) s.note(describeGroup(group));
    });

    await run.step('Switch to both', async (s) => {
      expectEqual('the mode', textOf(await mock.expect(200, 'PUT', '/api/legacy/mode', { body: { mode: 'both' } }), 'mode'), 'both');
      s.note('both: each of the legacy rule and Permit must allow');
      await expectRequest(s, mock, FRODO, HOBBITON, 'both', { legacy: true, permit: true, enforced: true });
      await expectRequest(s, mock, PIPPIN, HOBBITON, 'both', { legacy: true, permit: true, enforced: true });
      // The two tightenings the owner approved now take effect: the legacy table says yes, Permit says no, and no is enforced.
      await expectRequest(s, mock, FATTY, HOBBITON, 'both', { legacy: true, permit: false, enforced: false });
      await expectRequest(s, mock, LOBELIA, MICHEL_DELVING, 'both', { legacy: true, permit: false, enforced: false });
    });

    await run.step("Sam revokes Frodo's account admin role", async (s) => {
      const removed = numberOf(await portal.expect(200, 'DELETE', '/api/s2/grants', { persona: SAM, body: FRODOS_ROLE }), 'ms');
      if (!(removed > 0)) throw new StepError(`the revocation reports ${removed} ms on the PDP, so no role was removed`);
      revokedAt = Date.now();
      s.note(`Sam removed Frodo's ${FRODOS_ROLE.role} on ${FRODOS_ROLE.resource} in Team access (S2's API, the same Permit check): confirmed on the local PDP in ${ms(removed)}`);
    });

    await run.step("Frodo's legacy request is denied", async (s) => {
      await expectRequest(s, mock, FRODO, HOBBITON, 'both', { legacy: true, permit: false, enforced: false });
      // The legacy table was never touched: the revocation reached the legacy app through Permit alone.
      const frodo = listOf(await mock.expect(200, 'GET', '/api/legacy/state'), 'users').find((u) => textOf(u, 'key') === FRODO);
      expectSameItems("Frodo's accounts in the legacy table", frodo === undefined ? [] : listOf(frodo, 'accounts').map(String), ['EAN-1001']);
      s.note("the legacy table still lists EAN-1001 for Frodo: the revocation reached the legacy app without touching its table");
      await expectRequest(s, mock, SAM, BYWATER, 'both', { legacy: true, permit: true, enforced: true });
    });

    await run.step('Switch to Permit', async (s) => {
      expectEqual('the mode', textOf(await mock.expect(200, 'PUT', '/api/legacy/mode', { body: { mode: 'permit' } }), 'mode'), 'permit');
      s.note('permit: Permit decides and the legacy answer is only recorded');
      await expectRequest(s, mock, FRODO, HOBBITON, 'permit', { legacy: true, permit: false, enforced: false });
      await expectRequest(s, mock, PIPPIN, HOBBITON, 'permit', { legacy: true, permit: true, enforced: true });
      await expectRequest(s, mock, SAM, BYWATER, 'permit', { legacy: true, permit: true, enforced: true });
    });

    await run.step('Roll back to both', async (s) => {
      expectEqual('the mode', textOf(await mock.expect(200, 'PUT', '/api/legacy/mode', { body: { mode: 'both' } }), 'mode'), 'both');
      s.note('one switch back to both');
      await expectRequest(s, mock, FRODO, HOBBITON, 'both', { legacy: true, permit: false, enforced: false });
      await expectRequest(s, mock, PIPPIN, HOBBITON, 'both', { legacy: true, permit: true, enforced: true });
    });

    await run.step('Replay lists the changed decisions', async (s) => {
      // Permit's audit log lists the run some seconds after it happened. Wait by reading it, which adds nothing to it: a replay
      // asks every decision again, and would add them all to the log each time it ran.
      const waitMs = opts.auditWaitMs ?? AUDIT_WAIT_MS;
      let lastError: unknown;
      const waited = await pollUntil(async () => {
        try {
          return await opts.audited(FRODO, revokedAt);
        } catch (error) {
          lastError = error;
          return undefined;
        }
      }, (listed) => listed === true, { timeoutMs: waitMs, intervalMs: opts.auditPollMs ?? AUDIT_POLL_MS });
      if (!waited.ok && waited.value === undefined) throw new ServiceUnreachable(`Permit's audit log could not be read: ${describeError(lastError)}`);
      if (!waited.ok) throw new StepError(`after ${seconds(waited.elapsedMs)} Permit's audit log lists no decision of ${FRODO} made since the revocation: the run is not in it yet`);
      s.note(`Permit's audit log lists the run's decisions ${seconds(waited.elapsedMs)} after the revocation was confirmed`);

      // A replay that cannot read the log or ask the PDP has no verdict to give: it could not run, and is never a pass or a fail.
      const report = await opts.replay({ since: began, until: Date.now() }).catch((error: unknown): never => {
        throw new ServiceUnreachable(`the replay could not run: ${describeError(error)}`, { cause: error });
      });
      const revoked = report.changed.filter((c) => c.user === FRODO && c.then && !c.now);
      const fixed = report.changed.filter((c) => c.user === PIPPIN && !c.then && c.now);
      s.note(`${report.total} recorded ${VIEW_BILLING} decisions read from the audit log in ${report.pages} ${report.pages === 1 ? 'page' : 'pages'}, asked again against today's policy: ${report.unchanged} unchanged, ${report.changed.length} would change`);
      if (revoked.length === 0) {
        throw new StepError(`none of the ${report.total} decisions in the audit log since the run began would change for ${FRODO}: the revocation does not show in the replay`);
      }
      const first = revoked[0];
      s.note(`${FRODO}: ${revoked.length} decisions were ALLOW when made and are DENY now (for example ${first?.resource} at ${first?.at})`);
      if (fixed.length > 0) s.note(`${PIPPIN}: ${fixed.length} decisions were DENY when made and are ALLOW now (the mapping fix)`);
      if (report.unreplayable > 0) s.note(`${report.unreplayable} recorded decisions had nothing to ask again`);
    });
  });
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const env = scriptEnv();
    return runS8(env, { reset: () => runReset(env), ...auditTrailOf(env) });
  });
}
