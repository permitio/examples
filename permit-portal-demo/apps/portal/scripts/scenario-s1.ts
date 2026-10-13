// S1 end to end: Éowyn creates Riders of Rohan and becomes its first admin only once Great Eagle's trust facts hold
// and a Great Eagle reviewer approves; the organization never loses its last effective admin. The runner resets the demo
// (reset.ts, which ends with preflight) and waits until the PDP shows the reset state. Then it drives the portal's API,
// and the Great Eagle systems mock's trust service, as each persona, asserting every decision and status code. It is the
// automated rehearsal. Run: bin/demo scenario <profile> s1. Exit 0 pass, 1 fail, 2 could not run.
import { loadSeed, RESOURCE, TENANT } from '#src/server/model';
import { type ScriptEnv, scriptEnv } from '#scripts/lib/env';
import { isMain, type Outcome, type Result, runCli } from '#scripts/lib/report';
import { runReset } from '#scripts/reset';
import {
  Api, approvalOf, errorText, type Expected, expectDecisions, expectEqual, field, listOf, type Log, ms, NotReady, numberOf, requestOf,
  runScenario, seconds, type StepContext, StepError, waitForDecisions,
} from '#scripts/scenario-runner';

const EOWYN = 'eowyn';
const GANDALF = 'gandalf';
const EOMER = 'eomer';
const GRIMA = 'grima';
const EAN = 'EAN-2001';
const WRONG_PROOF = 'INV-0000-0000';
const DENY_COMMENT = 'duplicate of an existing registration';
const HANDOVER_REASON = 'Éomer takes over the account administration';
/** The reset writes straight to Permit, so they reach the PDP a little later: wait this long for them before step 1. */
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 500;

const ROHAN = TENANT.rohan;
const org = (key: string) => ({ type: RESOURCE.organization, key, tenant: key });
const onOrg = (user: string, action: string, expect: boolean): Expected => ({ user, action, ...org(ROHAN), expect });
const onEan = (user: string, expect: boolean): Expected => ({ user, action: 'view', type: RESOURCE.ean, key: EAN, tenant: ROHAN, expect });

/**
 * The reset state as the PDP must see it before step 1: Gríma's pending role in the LLC is back, and nobody holds a role
 * in Riders of Rohan, whose tenant the reset deleted. A previous run leaves Éowyn and Éomer with roles there.
 */
const RESET_STATE: Expected[] = [
  { user: GRIMA, action: 'view_own_request', ...org(TENANT.rohanLlc), expect: true },
  onOrg(EOWYN, 'view_own_request', false),
  onOrg(EOWYN, 'view_profile', false),
  onOrg(EOMER, 'view_profile', false),
];

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`demo-data/seed.json has no ${what}`);
  return value;
}

export interface S1Options {
  /** Puts the demo in its starting state first: runReset, or a stand-in in tests. */
  reset: () => Promise<Outcome>;
  log?: Log;
}

export async function runS1(env: Pick<ScriptEnv, 'profile' | 'portalUrl' | 'greatEagleSystemsUrl'>, opts: S1Options): Promise<Result> {
  const log = opts.log ?? console.log;
  const seed = loadSeed();
  const orgName = required(seed.organizations.find((o) => o.key === ROHAN)?.name, `organization ${ROHAN}`);
  const proof = required(seed.eans.find((e) => e.key === EAN)?.association_proof, `association proof for ${EAN}`);
  const portal = new Api('portal', env.portalUrl);
  const mock = new Api('Great Eagle systems mock', env.greatEagleSystemsUrl);

  /** Changes a fact in Great Eagle's trust service. The mock answers 200 only once the portal has written it to Permit, waited. */
  const setFact = async (s: StepContext, subject: 'users' | 'orgs', key: string, fact: Record<string, unknown>) => {
    await mock.expect(200, 'PUT', `/api/trust/${subject}/${key}`, { body: fact });
    s.note(`Great Eagle trust service: ${key} ${JSON.stringify(fact)}, applied to Permit by the portal`);
  };

  log(`S1 on profile ${env.profile}: portal ${env.portalUrl}, Great Eagle systems ${env.greatEagleSystemsUrl}`);
  return runScenario({ title: `S1 on ${env.profile}`, profile: env.profile, portal, reset: opts.reset, log }, async (run) => {
    await run.start('the PDP shows the reset state', async (s) => {
      const waited = await waitForDecisions(portal, RESET_STATE, { timeoutMs: START_TIMEOUT_MS, intervalMs: START_POLL_MS });
      for (const line of waited.lines) s.note(line);
      if (!waited.ok) throw new NotReady(`after ${seconds(waited.elapsedMs)} the PDP still answers ${waited.wrong.join('; ')}: the reset has not reached it`);
    });

    const firstAdmin = await run.step('Create the organization', async (s) => {
      const created = await portal.expect(201, 'POST', '/api/s1/organizations', { persona: EOWYN, body: { name: orgName } });
      const request = requestOf(field(created, 'request'));
      expectEqual("Éowyn's first-admin request", `${request.type} ${request.status}`, 'first_admin pending');
      s.note(`Éowyn created ${orgName}; the first-admin request ${request.id} waits for Great Eagle's review`);
      await expectDecisions(s, portal, [onOrg(EOWYN, 'manage_members', false), onOrg(EOWYN, 'view_own_request', true)]);
      return request.id;
    });

    await run.step('Great Eagle verifies identity and ownership', async (s) => {
      await setFact(s, 'users', EOWYN, { identity_verified: true });
      await setFact(s, 'orgs', ROHAN, { ownership_verified: true });
      // Still deny: approval is a separate gate, so Éowyn holds no org_admin role yet.
      await expectDecisions(s, portal, [onOrg(EOWYN, 'manage_members', false)]);
    });

    const grimasRequest = await run.step("Gandalf's queue", async (s) => {
      await setFact(s, 'users', EOWYN, { duplicate_check: 'suspected' });
      const queue = listOf(await portal.expect(200, 'GET', '/api/s1/reviewer-queue', { persona: GANDALF }), 'requests')
        .map((entry) => ({ request: requestOf(field(entry, 'request')), facts: field(entry, 'facts') }));
      s.note(`Gandalf may review the queue (Permit allowed review); it holds ${queue.map((q) => `${q.request.requested_for} (${q.request.tenant})`).join(', ')}`);
      const eowyns = queue.find((q) => q.request.id === firstAdmin);
      const grimas = queue.find((q) => q.request.requested_for === GRIMA && q.request.tenant === TENANT.rohanLlc);
      if (!eowyns || !grimas) throw new StepError(`Gandalf's queue lacks ${eowyns ? "Gríma's" : "Éowyn's"} first-admin request`);
      expectEqual("Éowyn's duplicate check in the queue", field(eowyns.facts, 'duplicate_check'), 'suspected');
      expectEqual("Gríma's duplicate check in the queue", field(grimas.facts, 'duplicate_check'), 'suspected');
      return grimas.request.id;
    });

    await run.step('Gandalf denies Gríma', async (s) => {
      const denied = requestOf(field(await portal.expect(200, 'POST', `/api/requests/${grimasRequest}/deny`, { persona: GANDALF, body: { comment: DENY_COMMENT } }), 'request'));
      expectEqual("Gríma's request", `${denied.status} by ${denied.reviewer}: ${denied.reviewer_comment}`, `denied by ${GANDALF}: ${DENY_COMMENT}`);
      s.note(`Gandalf denied ${grimasRequest}: "${DENY_COMMENT}"`);
      await expectDecisions(s, portal, [{ user: GRIMA, action: 'view_own_request', ...org(TENANT.rohanLlc), expect: false }]);
    });

    await run.step('Gandalf approves Éowyn', async (s) => {
      await setFact(s, 'users', EOWYN, { duplicate_check: 'clear' });
      const approval = approvalOf(await portal.expect(200, 'POST', `/api/requests/${firstAdmin}/approve`, { persona: GANDALF }));
      expectEqual("Éowyn's first-admin request", approval.request.status, 'approved');
      s.note(`Gandalf approved; org_admin was applied on the local PDP in ${ms(approval.ms)}`);
      await expectDecisions(s, portal, [onOrg(EOWYN, 'manage_members', true)]);
    });

    await run.step(`Associate ${EAN}`, async (s) => {
      await expectDecisions(s, portal, [onEan(EOWYN, false)]);
      const path = `/api/s1/organizations/${ROHAN}/ean-associations`;
      const refused = await portal.expect(422, 'POST', path, { persona: EOWYN, body: { ean: EAN, proof: WRONG_PROOF } });
      s.note(`a wrong proof is refused by the account master: "${errorText(refused)}"`);
      const associated = await portal.expect(201, 'POST', path, { persona: EOWYN, body: { ean: EAN, proof } });
      s.note(`the right proof: ${EAN} was created in Permit and applied on the local PDP in ${ms(numberOf(associated, 'ms'))}`);
      await expectDecisions(s, portal, [onEan(EOWYN, true)]);
    });

    await run.step('Risk suspended, then ok', async (s) => {
      await setFact(s, 'users', EOWYN, { risk_state: 'suspended' });
      await expectDecisions(s, portal, [onOrg(EOWYN, 'manage_members', false), onEan(EOWYN, false)]);
      // Both allow again once the fact is back: the suspension removed no role, the fact alone switched the access.
      await setFact(s, 'users', EOWYN, { risk_state: 'ok' });
      await expectDecisions(s, portal, [onOrg(EOWYN, 'manage_members', true), onEan(EOWYN, true)]);
    });

    await run.step('Éowyn invites Éomer', async (s) => {
      const invite = requestOf(await portal.expect(201, 'POST', `/api/s1/organizations/${ROHAN}/invitations`, { persona: EOWYN, body: { user: EOMER } }));
      s.note(`Éowyn invited Éomer (Permit allowed invite): request ${invite.id}`);
      const accepted = approvalOf(await portal.expect(200, 'POST', `/api/requests/${invite.id}/approve`, { persona: EOMER }));
      expectEqual("Éomer's invitation", accepted.request.status, 'approved');
      s.note(`Éomer accepted; org_member was applied on the local PDP in ${ms(accepted.ms)}`);
      await expectDecisions(s, portal, [onOrg(EOMER, 'view_profile', true)]);
    });

    await run.step('Admin handover to Éomer', async (s) => {
      const nomination = requestOf(await portal.expect(201, 'POST', `/api/s1/organizations/${ROHAN}/admin-transfers`,
        { persona: EOWYN, body: { to: EOMER, reason: HANDOVER_REASON } }));
      s.note(`Éowyn nominated Éomer (Permit allowed transfer_admin): request ${nomination.id}`);
      const accepted = approvalOf(await portal.expect(200, 'POST', `/api/requests/${nomination.id}/approve`, { persona: EOMER }));
      expectEqual('the handover', accepted.request.status, 'approved');
      s.note(`Éomer accepted; the handover's role changes were applied on the local PDP in ${ms(accepted.ms)}`);
      await expectDecisions(s, portal, [onOrg(EOMER, 'manage_members', true), onOrg(EOWYN, 'manage_members', false), onOrg(EOWYN, 'view_profile', true)]);
    });

    await run.step('Éomer cannot step down', async (s) => {
      const refused = await portal.expect(409, 'POST', `/api/s1/organizations/${ROHAN}/step-down`, { persona: EOMER });
      expectEqual("the portal's reason", errorText(refused), `${orgName} must keep at least one effective admin.`);
      s.note(`refused: "${errorText(refused)}"`);
      await expectDecisions(s, portal, [onOrg(EOMER, 'manage_members', true)]);
    });
  });
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const env = scriptEnv();
    return runS1(env, { reset: () => runReset(env) });
  });
}
