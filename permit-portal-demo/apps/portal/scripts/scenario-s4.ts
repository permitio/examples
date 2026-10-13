// S4 end to end: Aragorn, an external customs broker, gets narrow, approved, automatically expiring access to one
// shipment without joining Shire Freight. The runner resets the demo (reset.ts, which ends with preflight), then drives
// the portal's API as each persona and asserts every decision and status code. It is the automated rehearsal.
// Run: bin/demo scenario <profile> s4. SCENARIO_GRANT_MS sets Aragorn's grant: 10 s by default; the live demo uses 2 minutes.
// Exit 0 pass, 1 fail, 2 could not run.
import { RESOURCE, TENANT } from '#src/server/model';
import { type ScriptEnv, scriptEnv } from '#scripts/lib/env';
import { ARAGORN } from '#scripts/lib/fixtures';
import { pollUntil } from '#scripts/lib/pdp';
import { isMain, type Outcome, type Result, runCli } from '#scripts/lib/report';
import { runReset } from '#scripts/reset';
import {
  Api, approvalOf, booleanOf, errorText, type Expected, expectDecisions, expectEqual, field, isRecord, listOf, type Log, ms, numberOf,
  requestOf, runScenario, seconds, type StepContext, StepError,
} from '#scripts/scenario-runner';

const FRODO = 'frodo';
const SAM = 'sam';
const SHIPMENT = 'SHP-77001';
const OTHER_SHIPMENT = 'SHP-77002';
const RENEWAL_DAYS = 7;
const DEFAULT_GRANT_MS = 10_000;
/** A shorter grant can run out before step 5 has checked and uploaded. */
const MIN_GRANT_MS = 5_000;
/** The expiry must show within the grant's length plus this. */
const EXPIRY_SLACK_MS = 5_000;
const EXPIRY_POLL_MS = 200;
/** The portal's own texts (guards.ts and routes/s4.ts), which the audience reads on screen. */
const SELF_APPROVAL = 'A request cannot be approved by the person who made it or the person it is for.';
const RENEWAL_DENIED = 'Renewal not allowed by policy';

const shipment = (key: string) => ({ type: RESOURCE.shipment, key, tenant: TENANT.shire });
const isoOf = (time: number) => new Date(time).toISOString();

/** Step 2's checks for Aragorn: the invited shipment, another shipment on the same EAN, and the organization's profile. */
function aragornsChecks(invited: boolean): Expected[] {
  return [
    { user: ARAGORN, action: 'view', ...shipment(SHIPMENT), expect: invited },
    { user: ARAGORN, action: 'view', ...shipment(OTHER_SHIPMENT), expect: false },
    { user: ARAGORN, action: 'view_profile', type: RESOURCE.organization, key: TENANT.shire, tenant: TENANT.shire, expect: false },
  ];
}

interface Grant { expires: number; renewals_used: number }

/** The shipment page as Aragorn sees it: whether Aragorn may view it, and the grant entry as stored on Aragorn's Permit user. */
async function aragornsPage(portal: Api): Promise<{ canView: boolean; grant: Grant | undefined }> {
  const page = await portal.expect(200, 'GET', `/api/s4/shipments/${SHIPMENT}`, { persona: ARAGORN });
  const entry = listOf(page, 'collaborators').find((c) => field(c, 'user') === ARAGORN);
  return {
    canView: booleanOf(field(page, 'can'), 'view'),
    grant: entry === undefined ? undefined : { expires: numberOf(entry, 'expires'), renewals_used: numberOf(entry, 'renewals_used') },
  };
}

async function aragornsGrant(portal: Api): Promise<Grant> {
  const { grant } = await aragornsPage(portal);
  if (!grant) throw new StepError(`Aragorn has no grant entry on ${SHIPMENT}`);
  return grant;
}

/** The newest id in the decision panel's feed. Asking for the events after the largest possible id returns none. */
async function lastEventId(portal: Api): Promise<number> {
  return numberOf(await portal.expect(200, 'GET', `/api/events?since=${Number.MAX_SAFE_INTEGER}`, { persona: ARAGORN }), 'lastId');
}

/** Aragorn's view decisions on the shipment after event `since`, oldest first, with the current_time each check sent. */
async function aragornsViewDecisions(portal: Api, since: number): Promise<Array<{ allow: boolean; currentTime: number }>> {
  const events = listOf(await portal.expect(200, 'GET', `/api/events?since=${since}`, { persona: ARAGORN }), 'events');
  return events
    .filter((e) => isRecord(e) && e['kind'] === 'check' && e['user'] === ARAGORN && e['action'] === 'view' && e['resource'] === `${RESOURCE.shipment}:${SHIPMENT}` && e['error'] === undefined)
    .map((e) => ({ allow: booleanOf(e, 'allow'), currentTime: numberOf(field(field(field(e, 'input'), 'user'), 'attributes'), 'current_time') }));
}

/** Aragorn asks for 7 more days and Frodo approves: Aragorn may view again, with one more renewal used. */
async function renewal(s: StepContext, portal: Api, renewalsUsed: number): Promise<void> {
  const request = requestOf(await portal.expect(201, 'POST', `/api/s4/shipments/${SHIPMENT}/renewals`, { persona: ARAGORN, body: { days: RENEWAL_DAYS } }));
  s.note(`Aragorn asked for ${RENEWAL_DAYS} more days (Permit allowed request_renewal): request ${request.id}`);
  const approval = approvalOf(await portal.expect(200, 'POST', `/api/requests/${request.id}/approve`, { persona: FRODO }));
  expectEqual('the renewal request', approval.request.status, 'approved');
  s.note(`Frodo approved (Permit allowed approve_renewal); applied on the local PDP in ${ms(approval.ms)}`);
  await expectDecisions(s, portal, aragornsChecks(true));
  const grant = await aragornsGrant(portal);
  expectEqual("Aragorn's renewals_used", grant.renewals_used, renewalsUsed);
  s.note(`renewals_used ${grant.renewals_used}, expires ${isoOf(grant.expires)}`);
}

export interface S4Options {
  /** Aragorn's grant. The rehearsal waits for it to expire, so it lasts seconds; the live demo uses 2 minutes. */
  grantMs: number;
  /** Puts the demo in its starting state first: runReset, or a stand-in in tests. */
  reset: () => Promise<Outcome>;
  log?: Log;
}

export async function runS4(env: Pick<ScriptEnv, 'profile' | 'portalUrl'>, opts: S4Options): Promise<Result> {
  const log = opts.log ?? console.log;
  const portal = new Api('portal', env.portalUrl);
  log(`S4 on profile ${env.profile}: portal ${env.portalUrl}, Aragorn's grant ${opts.grantMs} ms`);
  return runScenario({ title: `S4 on ${env.profile}`, profile: env.profile, portal, reset: opts.reset, log }, async (run) => {
    const inviteId = await run.step('Invite', async (s) => {
      const invite = requestOf(await portal.expect(201, 'POST', `/api/s4/shipments/${SHIPMENT}/invitations`,
        { persona: FRODO, body: { user: ARAGORN, reason: 'customs clearance' } }));
      expectEqual('the invitation', invite.status, 'pending');
      s.note(`Frodo invited Aragorn to ${SHIPMENT}, reason "customs clearance" (Permit allowed invite_collaborator): request ${invite.id}`);
      return invite.id;
    });

    await run.step('Before approval', (s) => expectDecisions(s, portal, aragornsChecks(false)));

    await run.step('Self-approval refused', async (s) => {
      const refused = await portal.expect(409, 'POST', `/api/requests/${inviteId}/approve`, { persona: FRODO });
      expectEqual("the portal's reason", errorText(refused), SELF_APPROVAL);
      s.note(`Frodo may not approve the invitation Frodo sent: "${SELF_APPROVAL}"`);
    });

    await run.step('Sam approves', async (s) => {
      // The approver sets how long Aragorn's access lasts.
      const approval = approvalOf(await portal.expect(200, 'POST', `/api/requests/${inviteId}/approve`, { persona: SAM, body: { durationMs: opts.grantMs } }));
      expectEqual('the invitation', approval.request.status, 'approved');
      expectEqual('the reviewer', approval.request.reviewer, SAM);
      expectEqual('the duration the approver set', approval.request.duration_ms, opts.grantMs);
      if (!(approval.ms > 0)) throw new StepError(`the approval reports ${approval.ms} ms on the PDP, so no grant was written`);
      s.note(`Sam approved for ${opts.grantMs} ms (Permit allowed approve_collaborator); the grant was applied on the local PDP in ${ms(approval.ms)}`);
    });

    await run.step('After approval', async (s) => {
      await expectDecisions(s, portal, aragornsChecks(true));
      await portal.expect(201, 'POST', `/api/s4/shipments/${SHIPMENT}/documents`, { persona: ARAGORN, body: { name: 'customs-declaration.pdf' } });
      s.note('Aragorn uploaded customs-declaration.pdf (Permit allowed upload_docs)');
    });

    await run.step('Expiry', async (s) => {
      const since = await lastEventId(portal);
      const polled = await pollUntil(() => aragornsPage(portal), (page) => !page.canView, { timeoutMs: opts.grantMs + EXPIRY_SLACK_MS, intervalMs: EXPIRY_POLL_MS });
      if (!polled.ok) throw new StepError(`Aragorn could still view ${SHIPMENT} after ${seconds(polled.elapsedMs)}`);
      // The cleanup job has not run, so the entry is still on Aragorn's record: the policy itself denied Aragorn at the expiry.
      const { grant } = polled.value;
      if (!grant) throw new StepError("Aragorn's grant entry is gone, so this deny does not show the expiry");
      // Judged by the portal's clock, the current_time each check sent, never by this machine's clock.
      const decisions = await aragornsViewDecisions(portal, since);
      const firstDeny = decisions.find((d) => !d.allow);
      if (!firstDeny) throw new StepError(`the decision panel's feed has no deny for Aragorn's view of ${SHIPMENT}`);
      if (firstDeny.currentTime < grant.expires) {
        throw new StepError(`Permit denied Aragorn at current_time ${isoOf(firstDeny.currentTime)}, before the grant's expiry ${isoOf(grant.expires)}`);
      }
      const lateAllow = decisions.find((d) => d.allow && d.currentTime > grant.expires);
      if (lateAllow) throw new StepError(`Permit allowed Aragorn at current_time ${isoOf(lateAllow.currentTime)}, after the grant's expiry ${isoOf(grant.expires)}`);
      s.note(`the grant expired at ${isoOf(grant.expires)}; the first deny came at current_time +${firstDeny.currentTime - grant.expires} ms`);
      s.note(`no allow after the expiry in ${decisions.length} view decisions; the grant entry is still on Aragorn's record`);
    });

    await run.step('First renewal', (s) => renewal(s, portal, 1));
    await run.step('Second renewal', (s) => renewal(s, portal, 2));

    await run.step('Third renewal', async (s) => {
      const refused = await portal.expect(403, 'POST', `/api/s4/shipments/${SHIPMENT}/renewals`, { persona: ARAGORN, body: { days: RENEWAL_DAYS } });
      expectEqual("the portal's reason", errorText(refused), RENEWAL_DENIED);
      expectEqual('the decision', field(refused, 'decision'), 'deny');
      s.note(`denied by policy: "${RENEWAL_DENIED}" (renewals_used is at the limit of 2)`);
    });

    await run.step('Revocation', async (s) => {
      const applied = numberOf(await portal.expect(200, 'POST', `/api/s4/shipments/${SHIPMENT}/revoke`, { persona: FRODO, body: { user: ARAGORN } }), 'ms');
      if (!(applied > 0)) throw new StepError(`the revocation reports ${applied} ms on the PDP, so no grant entry was removed`);
      s.note(`Frodo revoked Aragorn (Permit allowed revoke_collaborator); applied on the local PDP in ${ms(applied)}`);
      await expectDecisions(s, portal, [...aragornsChecks(false), { user: SAM, action: 'view', ...shipment(SHIPMENT), expect: true }]);
    });
  });
}

/** SCENARIO_GRANT_MS in whole milliseconds (10 s when unset), or undefined when it is not a usable length. */
function grantMsOf(raw: string | undefined): number | undefined {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_GRANT_MS : Number(raw);
  return Number.isSafeInteger(value) && value >= MIN_GRANT_MS ? value : undefined;
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const env = scriptEnv();
    const grantMs = grantMsOf(process.env['SCENARIO_GRANT_MS']);
    if (grantMs === undefined) return { outcome: 'could-not-run', summary: `SCENARIO_GRANT_MS must be a whole number of milliseconds, at least ${MIN_GRANT_MS}` };
    return runS4(env, { grantMs, reset: () => runReset(env) });
  });
}
