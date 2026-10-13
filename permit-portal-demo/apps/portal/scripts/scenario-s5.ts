// S5 end to end: Pippin, a developer, registers the Shire ERP connector, which gets a sandbox scope only; Sam, the
// business approver, authorizes production on EAN-1001 alone; and Sam can later make the connector view-only and then revoke
// it. The runner resets the demo (reset.ts, which ends with preflight), then drives the portal's API as each persona, and the
// connector itself through the console's "Run the connector" call of Great Eagle's systems, which holds its credential.
// It asserts every decision and status code. It is the automated rehearsal. The connector's client secret is shown to the
// runner once, at registration: it is never printed, and every line the runner prints passes through a filter for it.
// Run: bin/demo scenario <profile> s5. Exit 0 pass, 1 fail, 2 could not run.
import { TENANT } from '#src/server/model';
import { type ScriptEnv, scriptEnv } from '#scripts/lib/env';
import { isMain, type Outcome, type Result, runCli } from '#scripts/lib/report';
import { runReset } from '#scripts/reset';
import {
  Api, approvalOf, errorText, type Expected, eventsSince, expectDecisions, expectEqual, expectSameItems, field, lastEventId, listOf, type Log, ms, NotReady,
  numberOf, requestOf, runScenario, StepError, textOf,
} from '#scripts/scenario-runner';

const PIPPIN = 'pippin';
const SAM = 'sam';
const FRODO = 'frodo';
const CONNECTOR = 'shire-erp';
const CONNECTOR_NAME = 'Shire ERP connector';
const SANDBOX = 'EAN-SANDBOX';
const PRODUCTION = 'EAN-1001';
const OTHER = 'EAN-1002';
const REASON = 'Create and view shipments for the Shire ERP rollout';
/** The portal's own texts (routes/integration-api.ts and guards.ts), which the audience reads on screen. */
const UNKNOWN_CREDENTIAL = 'Unknown client credential';
const SELF_APPROVAL = 'A request cannot be approved by the person who made it or the person it is for.';
/** What the runner shows in place of the client secret. */
const HIDDEN = '[client secret]';
/** The portal keeps the connector's ten latest calls on its card. */
const RECENT_CALLS = 10;

type Op = 'create' | 'list';
/** What each operation of the connector asks Permit (routes/integration-api.ts). */
const ACTION: Record<Op, string> = { create: 'create_shipment', list: 'view' };
const refusal = (op: Op, ean: string) => `Permit denied ${ACTION[op]} on ean:${ean}.`;

const onEan = (user: string, action: string, ean: string, expect: boolean): Expected => ({ user, action, type: 'ean', key: ean, tenant: TENANT.shire, expect });

/** `role resource`, as the connector's scope lists it. */
const pair = (role: string, resource: string) => `${role} ${resource}`;

/** The roles Permit holds for the connector now, from its card. */
function scopeOf(integration: unknown): string[] {
  return listOf(integration, 'scope').map((entry) => pair(textOf(entry, 'role'), textOf(entry, 'resource')));
}

/** A body that is a list itself (Great Eagle's systems list shipments that way). */
function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new StepError(`expected a list in ${what}`);
  return value;
}

export interface S5Options {
  /** Puts the demo in its starting state first: runReset, or a stand-in in tests. */
  reset: () => Promise<Outcome>;
  log?: Log;
}

export async function runS5(env: Pick<ScriptEnv, 'profile' | 'portalUrl' | 'greatEagleSystemsUrl'>, opts: S5Options): Promise<Result> {
  const out = opts.log ?? console.log;
  const portal = new Api('portal', env.portalUrl);
  const mock = new Api('Great Eagle systems mock', env.greatEagleSystemsUrl);

  // The client secret exists in this process from registration on. Whatever the runner prints, or says in its summary, goes
  // through scrub(), so not even a failure message that quotes an answer can show it.
  let secret: string | undefined;
  const scrub = (text: string) => (secret === undefined ? text : text.split(secret).join(HIDDEN));
  const log: Log = (line) => out(scrub(line));
  const expectNoSecret = (where: string, value: unknown) => {
    if (secret !== undefined && JSON.stringify(value).includes(secret)) throw new StepError(`the client secret appears in ${where}`);
  };

  /** The console's "Run the connector": Great Eagle's systems call the portal's integration API with the credential they hold. */
  const runConnector = async (op: Op, ean: string) => {
    const answer = await mock.expect(200, 'POST', `/api/integrations/${CONNECTOR}/run`, { body: { op, ean } });
    expectNoSecret("the connector's run answer", answer);
    return { status: numberOf(answer, 'status'), body: field(answer, 'body') };
  };
  const expectRan = (op: Op, ean: string, ran: { status: number; body: unknown }, status: number) => {
    if (ran.status !== status) throw new StepError(`the connector's ${op} on ${ean} answered ${ran.status}, expected ${status}: ${errorText(ran.body)}`);
  };
  const expectDenied = async (op: Op, ean: string) => {
    const ran = await runConnector(op, ean);
    expectRan(op, ean, ran, 403);
    expectEqual(`Permit's reason for the ${op} on ${ean}`, textOf(ran.body, 'error'), refusal(op, ean));
  };
  const cardOf = async (persona: string) => {
    const card = listOf(await portal.expect(200, 'GET', '/api/s5/integrations', { persona }), 'integrations').find((i) => textOf(i, 'key') === CONNECTOR);
    if (card === undefined) throw new StepError(`${persona}'s integrations list does not have ${CONNECTOR}`);
    return card;
  };
  const approvalsOf = async (persona: string) => listOf(await portal.expect(200, 'GET', '/api/approvals', { persona }), 'requests');

  log(`S5 on profile ${env.profile}: portal ${env.portalUrl}, Great Eagle systems ${env.greatEagleSystemsUrl}`);
  const result = await runScenario({ title: `S5 on ${env.profile}`, profile: env.profile, portal, reset: opts.reset, log }, async (run) => {
    await run.start('no connector is registered', async (s) => {
      const listed = listOf(await portal.expect(200, 'GET', '/api/s5/integrations', { persona: SAM }), 'integrations');
      if (listed.length > 0) throw new NotReady(`the reset left ${listed.map((i) => textOf(i, 'key')).join(', ')} registered`);
      s.note('Great Eagle systems list no connector');
    });

    let requestId = '';

    await run.step('Pippin registers the connector', async (s) => {
      const registered = await portal.expect(201, 'POST', '/api/s5/integrations', { persona: PIPPIN, body: { key: CONNECTOR, name: CONNECTOR_NAME } });
      const issued = textOf(registered, 'client_secret');
      // Held from here on, so that nothing printed can show it. An empty answer is nothing to hide: filtering for it would garble every line.
      if (issued !== '') secret = issued;
      if (!/^[0-9a-f]{64}$/.test(issued)) throw new StepError('the client secret is not 64 hexadecimal characters');
      const integration = field(registered, 'integration');
      expectEqual("the connector's owner", textOf(integration, 'owner'), PIPPIN);
      expectEqual('the customer it acts for', textOf(integration, 'customer'), TENANT.shire);
      expectSameItems("the connector's scope", scopeOf(integration), [pair('integration_client', `ean:${SANDBOX}`)]);
      s.note(`Pippin registered ${CONNECTOR_NAME} as ${CONNECTOR}: Great Eagle's systems issued a client credential, shown once and not printed here`);
      s.note(`Permit gave the connector its own identity and integration_client on ${SANDBOX} only`);
      // The credential is the one thing that must never come back: not in a list, the registry, the decision panel or a repeat.
      for (const persona of [PIPPIN, SAM]) expectNoSecret(`${persona}'s integrations list`, await portal.expect(200, 'GET', '/api/s5/integrations', { persona }));
      expectNoSecret("Great Eagle systems' registry", await mock.expect(200, 'GET', '/api/integrations'));
      expectNoSecret("the portal's decision-panel feed", await portal.expect(200, 'GET', '/api/events?since=0', { persona: PIPPIN }));
      const again = await portal.send('POST', '/api/s5/integrations', { persona: PIPPIN, body: { key: CONNECTOR, name: CONNECTOR_NAME } });
      expectEqual('the status of a second registration of the same key', again.status, 409);
      expectNoSecret('the refusal of a second registration', again.body);
      // Only the connector's own credential gets in: none, or one nobody issued, is a 401 and never a default principal.
      const shipment = { ean: SANDBOX, title: 'no credential' };
      const anonymous = await portal.send('POST', '/api/integration/shipments', { body: shipment });
      expectEqual("the integration API's status without a credential", anonymous.status, 401);
      const stranger = await portal.send('POST', '/api/integration/shipments', { headers: { authorization: `Bearer ${'0'.repeat(64)}` }, body: shipment });
      expectEqual("the integration API's status for a credential nobody issued", stranger.status, 401);
      expectEqual("the integration API's reason", errorText(stranger.body), UNKNOWN_CREDENTIAL);
      s.note(`a second registration of ${CONNECTOR} is refused with 409; a call with no credential, or one nobody issued, is refused with 401`);
    });

    await run.step('The sandbox scope works', async (s) => {
      const created = await runConnector('create', SANDBOX);
      expectRan('create', SANDBOX, created, 201);
      expectEqual('the shipment it created: its EAN', textOf(created.body, 'ean'), SANDBOX);
      expectEqual('the shipment it created: its creator', textOf(created.body, 'created_by'), CONNECTOR);
      const key = textOf(created.body, 'key');
      const listed = await runConnector('list', SANDBOX);
      expectRan('list', SANDBOX, listed, 200);
      expectSameItems(`the shipments it sees on ${SANDBOX}`, listOf(listed.body, 'shipments').map((x) => textOf(x, 'key')), [key]);
      s.note(`the connector created ${key} on ${SANDBOX} (201) and listed it (200)`);
    });

    await run.step('Production is denied before approval', async (s) => {
      const asked = await portal.expect(201, 'POST', `/api/s5/integrations/${CONNECTOR}/production-requests`, { persona: PIPPIN, body: { ean: PRODUCTION, reason: REASON } });
      const request = requestOf(asked);
      expectEqual("Pippin's request", `${request.type} ${request.status}`, 'integration_access pending');
      expectEqual('the connector the request is for', request.requested_for, CONNECTOR);
      expectEqual('the scope asked for', textOf(asked, 'target'), `ean:${PRODUCTION}`);
      requestId = request.id;
      s.note(`Pippin asked for production scope on ${PRODUCTION}, "${REASON}": request ${request.id} waits for Sam`);
      await expectDenied('create', PRODUCTION);
      await expectDenied('list', PRODUCTION);
      s.note(`until then the connector is denied on ${PRODUCTION}: 403 "${refusal('create', PRODUCTION)}"`);
    });

    await run.step('The request reaches Sam', async (s) => {
      const entry = (await approvalsOf(SAM)).find((r) => textOf(r, 'id') === requestId);
      if (entry === undefined) throw new StepError(`Sam's approvals do not list request ${requestId}`);
      expectEqual('the developer', textOf(entry, 'initiated_by'), PIPPIN);
      expectEqual('the connector', textOf(entry, 'requested_for'), CONNECTOR);
      expectEqual('the scope', pair(textOf(entry, 'role'), textOf(entry, 'target')), pair('integration_client', `ean:${PRODUCTION}`));
      expectEqual('the reason', textOf(entry, 'reason'), REASON);
      s.note(`Sam's approvals list it: developer ${PIPPIN}, connector ${CONNECTOR}, integration_client on ${PRODUCTION}, "${REASON}"`);
      // Nobody else is asked: the developer is shut out by the four-eyes rule, and an EAN admin by Permit.
      for (const persona of [PIPPIN, FRODO]) {
        if ((await approvalsOf(persona)).some((r) => textOf(r, 'id') === requestId)) throw new StepError(`${persona}'s approvals list the request, and ${persona} may not decide it`);
      }
      s.note("Pippin's and Frodo's approvals do not list it");
    });

    await run.step('Pippin cannot approve it', async (s) => {
      const refused = await portal.expect(409, 'POST', `/api/requests/${requestId}/approve`, { persona: PIPPIN });
      expectEqual("the portal's reason", errorText(refused), SELF_APPROVAL);
      s.note(`Pippin may not approve the request Pippin made: "${SELF_APPROVAL}"`);
      // Frodo is neither the developer nor the connector, so the four-eyes rule lets Frodo through, and Permit refuses Frodo.
      const denied = await portal.expect(403, 'POST', `/api/requests/${requestId}/approve`, { persona: FRODO });
      expectEqual("Permit's reason", errorText(denied), 'Permit denied approve_integration on ean:EAN-1001.');
      s.note(`Frodo administers ${PRODUCTION} and still may not approve: 403 "${errorText(denied)}"`);
      const pending = (await approvalsOf(SAM)).find((r) => textOf(r, 'id') === requestId);
      if (pending === undefined || textOf(pending, 'status') !== 'pending') throw new StepError('the request is no longer pending after two refused approvals');
    });

    await run.step('Sam approves', async (s) => {
      const approval = approvalOf(await portal.expect(200, 'POST', `/api/requests/${requestId}/approve`, { persona: SAM }));
      expectEqual('the request', approval.request.status, 'approved');
      expectEqual('the reviewer', approval.request.reviewer, SAM);
      if (!(approval.ms > 0)) throw new StepError(`the approval reports ${approval.ms} ms on the PDP, so no role was written`);
      s.note(`Sam approved (Permit allowed approve_integration); integration_client on ${PRODUCTION} was applied on the local PDP in ${ms(approval.ms)}`);
      // The role went to the connector's own identity, never to the developer who asked.
      expectSameItems("the connector's scope", scopeOf(await cardOf(SAM)), [pair('integration_client', `ean:${PRODUCTION}`), pair('integration_client', `ean:${SANDBOX}`)]);
      await expectDecisions(s, portal, [onEan(PIPPIN, 'view', PRODUCTION, false), onEan(PIPPIN, 'create_shipment', PRODUCTION, false)]);
    });

    let created = '';

    await run.step('Create on EAN-1001 is allowed', async (s) => {
      const since = await lastEventId(portal);
      const ran = await runConnector('create', PRODUCTION);
      expectRan('create', PRODUCTION, ran, 201);
      expectEqual('the shipment it created: its EAN', textOf(ran.body, 'ean'), PRODUCTION);
      created = textOf(ran.body, 'key');
      // Permit authorized the create and stored nothing: Great Eagle's systems, the system of record, hold the shipment.
      const stored = asList(await mock.expect(200, 'GET', `/api/shipments?ean=${PRODUCTION}`), 'the shipments Great Eagle systems hold');
      expectSameItems(`the shipments Great Eagle systems hold on ${PRODUCTION}`, stored.map((x) => textOf(x, 'key')), [created]);
      // The decision panel names the connector as the subject of the check.
      const check = (await eventsSince(portal, since)).find((e) => e.kind === 'check' && e.user === CONNECTOR && e.action === 'create_shipment' && e.resource === `ean:${PRODUCTION}`);
      if (check?.kind !== 'check' || !check.allow) throw new StepError(`the decision panel has no allowed create_shipment check as ${CONNECTOR} on ean:${PRODUCTION}`);
      expectEqual('the subject the decision panel shows', check.label, CONNECTOR_NAME);
      s.note(`the connector created ${created} on ${PRODUCTION} (201); the decision panel shows the check with "${CONNECTOR_NAME}" as the subject`);
    });

    await run.step('Create on EAN-1002 is denied', async (s) => {
      await expectDenied('create', OTHER);
      expectSameItems(`the shipments Great Eagle systems hold on ${OTHER}`, asList(await mock.expect(200, 'GET', `/api/shipments?ean=${OTHER}`), 'the shipments').map((x) => textOf(x, 'key')), []);
      s.note(`403 "${refusal('create', OTHER)}"; nothing was stored`);
      // Not a limit of what exists: Sam, who approved the connector, can see EAN-1002.
      await expectDecisions(s, portal, [onEan(SAM, 'view', OTHER, true)]);
    });

    await run.step('View-only: create denied, list allowed', async (s) => {
      const swap = numberOf(await portal.expect(200, 'POST', `/api/s5/integrations/${CONNECTOR}/scope`, { persona: SAM, body: { ean: PRODUCTION, level: 'read' } }), 'ms');
      if (!(swap > 0)) throw new StepError(`the swap reports ${swap} ms on the PDP, so no role changed`);
      s.note(`Sam made the connector view-only on ${PRODUCTION}: integration_reader in, integration_client out, applied on the local PDP in ${ms(swap)}`);
      expectSameItems("the connector's scope", scopeOf(await cardOf(SAM)), [pair('integration_reader', `ean:${PRODUCTION}`), pair('integration_client', `ean:${SANDBOX}`)]);
      await expectDenied('create', PRODUCTION);
      const listed = await runConnector('list', PRODUCTION);
      expectRan('list', PRODUCTION, listed, 200);
      if (!listOf(listed.body, 'shipments').some((x) => textOf(x, 'key') === created)) throw new StepError(`the list on ${PRODUCTION} does not show ${created}`);
      s.note(`create is 403 "${refusal('create', PRODUCTION)}"; the list is 200 and shows ${created}`);
    });

    await run.step('Revoke: everything is denied', async (s) => {
      // As the UI does: every EAN the connector holds a role on, the production ones first and the sandbox last.
      const eans = [...new Set(scopeOf(await cardOf(SAM)).map((entry) => entry.split(' ')[1] ?? '').map((resource) => resource.replace(/^ean:/, '')))]
        .sort((a, b) => Number(a === SANDBOX) - Number(b === SANDBOX));
      expectSameItems('the EANs the connector holds a role on', eans, [PRODUCTION, SANDBOX]);
      for (const ean of eans) {
        const removed = numberOf(await portal.expect(200, 'POST', `/api/s5/integrations/${CONNECTOR}/scope`, { persona: SAM, body: { ean, level: 'none' } }), 'ms');
        s.note(`Sam revoked the connector on ${ean}: applied on the local PDP in ${ms(removed)}`);
      }
      for (const [op, ean] of [['create', PRODUCTION], ['list', PRODUCTION], ['create', SANDBOX], ['list', SANDBOX], ['create', OTHER]] as const) await expectDenied(op, ean);
      s.note(`every call is 403 now: create and list on ${PRODUCTION} and ${SANDBOX}, and create on ${OTHER}`);
      // What Sam reviews afterwards: no role left, the request recorded as revoked, and the latest calls, newest first.
      const card = await cardOf(SAM);
      expectSameItems("the connector's scope", scopeOf(card), []);
      const request = listOf(card, 'requests').find((r) => textOf(r, 'id') === requestId);
      expectEqual("the production request's status", request === undefined ? undefined : textOf(request, 'status'), 'revoked');
      const recent = listOf(card, 'recent').map((call) => ({ allow: field(call, 'allow'), at: numberOf(call, 'at') }));
      expectEqual("the number of calls on Sam's card", recent.length, RECENT_CALLS);
      if (!recent.slice(0, 5).every((call) => call.allow === false)) throw new StepError("Sam's card does not show the five calls made after the revocation as denied");
      if (!recent.some((call) => call.allow === true)) throw new StepError("Sam's card shows no call that was allowed, so the review cannot show what changed");
      if (recent.some((call, i) => i > 0 && call.at > (recent[i - 1]?.at ?? Number.POSITIVE_INFINITY))) throw new StepError("Sam's card does not list the calls newest first");
      s.note(`Sam's card lists the connector's latest ${recent.length} calls, newest first: the 5 after the revocation denied, the earlier ones as they were`);
      // The secret never came back in anything the runner read.
      expectNoSecret("Sam's card", card);
      expectNoSecret("the portal's decision-panel feed", await portal.expect(200, 'GET', '/api/events?since=0', { persona: SAM }));
      expectNoSecret("Great Eagle systems' registry", await mock.expect(200, 'GET', '/api/integrations'));
    });
  });
  return { ...result, summary: scrub(result.summary) };
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const env = scriptEnv();
    return runS5(env, { reset: () => runReset(env) });
  });
}
