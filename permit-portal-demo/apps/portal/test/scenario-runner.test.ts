import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Result, runCli } from '../scripts/lib/report';
import type { DecisionChange, ReplayReport } from '../scripts/replay';
import { Api, awaitResetState, type Expected, expectSameItems, runScenario, StepError } from '../scripts/scenario-runner';
import { runS1 } from '../scripts/scenario-s1';
import { runS2 } from '../scripts/scenario-s2';
import { runS4 } from '../scripts/scenario-s4';
import { runS5 } from '../scripts/scenario-s5';
import { type AuditTrail, auditTrailWith, runS8 } from '../scripts/scenario-s8';
import { type Reply, S5_SECRET, type S2Bugs, type S5Bugs, type S8Bugs, type Seen, s2World, s5World, s8World } from './fakes-runners';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/**
 * A stand-in for the portal: records every request, in order. GET /api/meta names the portal's profile, and `reply`
 * answers everything else.
 */
async function startPortal(reply: (req: Seen) => Reply, profile = 'test'): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const persona = req.headers['x-demo-persona'];
    const authorization = req.headers.authorization;
    const request: Seen = {
      method: req.method ?? '', path: req.url ?? '', ...(typeof persona === 'string' ? { persona } : {}),
      ...(typeof authorization === 'string' ? { authorization } : {}), body: raw ? JSON.parse(raw) : undefined,
    };
    seen.push(request);
    const [status, body] = request.method === 'GET' && request.path === '/api/meta' ? [200, { profile }] : reply(request);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Runs a scenario the way bin/demo does, through runCli, with process.exit stubbed: answers the exit code and the summary line. */
async function exitOf(main: () => Promise<Result>): Promise<{ code: number; summary: string }> {
  const printed: string[] = [];
  const capture = (...args: unknown[]) => {
    printed.push(args.join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exited(Number(code));
  });
  const exited = await runCli(main).then(() => undefined, (e: unknown) => e);
  if (!(exited instanceof Exited)) throw new Error(`runCli did not exit: ${String(exited)}`);
  return { code: exited.code, summary: printed.join('\n').trim() };
}

const META: Seen = { method: 'GET', path: '/api/meta', persona: 'aragorn', body: undefined };
const decisions = (...allows: boolean[]) => ({ results: allows.map((allow) => ({ allow })), ms: 1 });
const verdicts = (lines: string[]) => lines.filter((line) => /^(PASS|FAIL)/.test(line));
const unexpected = (req: Seen): Reply => [500, { error: `unexpected ${req.method} ${req.path}` }];
const pass = async () => 'pass' as const;

describe('scenario runners', () => {
  it('S4 stops at the first failing step and exits 1, naming the step', async () => {
    // Step 1 holds. At step 2 the portal lets Aragorn view SHP-77001 before anyone approved: the rehearsal must stop there.
    const invite = { id: 'req-test-1', type: 'collaborator_invite', status: 'pending', tenant: 'shire-freight', requested_for: 'aragorn', initiated_by: 'frodo' };
    const portal = await startPortal((req) => {
      if (req.method === 'POST' && req.path === '/api/s4/shipments/SHP-77001/invitations') return [201, invite];
      if (req.method === 'POST' && req.path === '/api/checks/bulk') return [200, decisions(true, false, false)];
      return unexpected(req);
    });
    const lines: string[] = [];

    const exit = await exitOf(() => runS4({ profile: 'test', portalUrl: portal.url }, { grantMs: 10_000, reset: pass, log: (line) => lines.push(line) }));

    expect(exit.code).toBe(1);
    expect(exit.summary).toMatch(/^FAIL: S4 on test stopped at step 2 \(Before approval\): /);
    expect(verdicts(lines)).toEqual([expect.stringMatching(/^PASS +1\. Invite/), expect.stringMatching(/^FAIL +2\. Before approval/)]);
    expect(lines.join('\n')).toContain('aragorn view shipment:SHP-77001@shire-freight: expected deny, got allow');
    // Nothing after step 2 reached the portal: no self-approval attempt and no approval.
    expect(portal.seen).toEqual([
      META,
      { method: 'POST', path: '/api/s4/shipments/SHP-77001/invitations', persona: 'frodo', body: { user: 'aragorn', reason: 'customs clearance' } },
      { method: 'POST', path: '/api/checks/bulk', persona: 'aragorn', body: { checks: [
        { action: 'view', resource: { type: 'shipment', key: 'SHP-77001', tenant: 'shire-freight' } },
        { action: 'view', resource: { type: 'shipment', key: 'SHP-77002', tenant: 'shire-freight' } },
        { action: 'view_profile', resource: { type: 'organization', key: 'shire-freight', tenant: 'shire-freight' } },
      ] } },
    ]);
  });

  it('S1 waits for the reset state on the PDP, then stops when step 1 gets a wrong decision', async () => {
    // The PDP already shows the reset state. After the org is created, it wrongly lets pending Éowyn manage members.
    let created = false;
    const createdBody = {
      org: { key: 'riders-of-rohan', name: 'Riders of Rohan', ownership_verified: false },
      request: { id: 'req-test-2', type: 'first_admin', status: 'pending', tenant: 'riders-of-rohan', requested_for: 'eowyn', initiated_by: 'eowyn' },
    };
    const allows = (persona: string | undefined, action: string) =>
      persona === 'grima' || (persona === 'eowyn' && created && (action === 'manage_members' || action === 'view_own_request'));
    const portal = await startPortal((req) => {
      if (req.method === 'POST' && req.path === '/api/checks/bulk') {
        const checks = (req.body as { checks: Array<{ action: string }> }).checks;
        return [200, decisions(...checks.map((c) => allows(req.persona, c.action)))];
      }
      if (req.method === 'POST' && req.path === '/api/s1/organizations') {
        created = true;
        return [201, createdBody];
      }
      return unexpected(req);
    });
    const lines: string[] = [];

    const exit = await exitOf(() => runS1({ profile: 'test', portalUrl: portal.url, greatEagleSystemsUrl: portal.url }, { reset: pass, log: (line) => lines.push(line) }));

    expect(exit.code).toBe(1);
    expect(exit.summary).toMatch(/^FAIL: S1 on test stopped at step 1 \(Create the organization\): /);
    expect(verdicts(lines)).toEqual([expect.stringMatching(/^PASS +Start: /), expect.stringMatching(/^FAIL +1\. Create the organization/)]);
    expect(lines.join('\n')).toContain('eowyn manage_members organization:riders-of-rohan@riders-of-rohan: expected deny, got allow');
    const org = (key: string) => ({ type: 'organization', key, tenant: key });
    expect(portal.seen).toEqual([
      META,
      { method: 'POST', path: '/api/checks/bulk', persona: 'grima', body: { checks: [{ action: 'view_own_request', resource: org('riders-of-rohan-llc') }] } },
      { method: 'POST', path: '/api/checks/bulk', persona: 'eowyn', body: { checks: [
        { action: 'view_own_request', resource: org('riders-of-rohan') }, { action: 'view_profile', resource: org('riders-of-rohan') },
      ] } },
      { method: 'POST', path: '/api/checks/bulk', persona: 'eomer', body: { checks: [{ action: 'view_profile', resource: org('riders-of-rohan') }] } },
      { method: 'POST', path: '/api/s1/organizations', persona: 'eowyn', body: { name: 'Riders of Rohan' } },
      { method: 'POST', path: '/api/checks/bulk', persona: 'eowyn', body: { checks: [
        { action: 'manage_members', resource: org('riders-of-rohan') }, { action: 'view_own_request', resource: org('riders-of-rohan') },
      ] } },
    ]);
  });

  it('a portal that does not answer means the scenario could not run: exit 2, never a pass', async () => {
    const portal = await startPortal(unexpected);
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const reset = vi.fn(pass);

    const exit = await exitOf(() => runS4({ profile: 'test', portalUrl: portal.url }, { grantMs: 10_000, reset, log: () => undefined }));

    expect(exit.code).toBe(2);
    expect(exit.summary).toMatch(/^COULD NOT RUN: S4 on test did not start: the portal at .* did not answer GET \/api\/meta/);
    expect(reset).not.toHaveBeenCalled();
  });

  it('refuses a portal that runs another profile, before resetting anything', async () => {
    const portal = await startPortal(unexpected, 'staging');
    const reset = vi.fn(pass);

    const exit = await exitOf(() => runS1({ profile: 'demo', portalUrl: portal.url, greatEagleSystemsUrl: portal.url }, { reset, log: () => undefined }));

    expect(exit.code).toBe(2);
    expect(exit.summary).toMatch(/^COULD NOT RUN: S1 on demo did not start: the portal at .* runs profile staging/);
    expect(reset).not.toHaveBeenCalled();
    expect(portal.seen).toEqual([META]);
  });

  it('does not start when the reset does not pass, and says it could not run', async () => {
    const portal = await startPortal(unexpected);

    const exit = await exitOf(() => runS4({ profile: 'test', portalUrl: portal.url }, { grantMs: 10_000, reset: async () => 'fail', log: () => undefined }));

    expect(exit.code).toBe(2);
    expect(exit.summary).toMatch(/^COULD NOT RUN: S4 on test did not start, because the reset did not pass/);
    expect(portal.seen).toEqual([META]);
  });

  it('prints PASS for every step, with its notes, and passes when each one holds', async () => {
    const portal = await startPortal(unexpected);
    const lines: string[] = [];

    const result = await runScenario({ title: 'demo', profile: 'test', portal: new Api('portal', portal.url), reset: pass, log: (line) => lines.push(line) }, async (run) => {
      await run.step('first', async (s) => {
        s.note('a note');
      });
      await run.step('second', async () => undefined);
    });

    expect(result).toEqual({ outcome: 'pass', summary: expect.stringMatching(/^demo: all 2 steps passed/) });
    expect(verdicts(lines)).toEqual([expect.stringMatching(/^PASS +1\. first/), expect.stringMatching(/^PASS +2\. second/)]);
    expect(lines).toContainEqual(expect.stringMatching(/^ +a note$/));
  });
});

// --- S2, S5 and S8: the runners over the stand-in worlds of fakes-runners.ts ---

const env = (url: string) => ({ profile: 'test', portalUrl: url, greatEagleSystemsUrl: url });

/** Runs a runner against a stand-in world the way bin/demo does, and answers the exit, what it printed and what reached the world. */
async function rehearse(reply: (req: Seen) => Reply, run: (url: string, log: (line: string) => void) => Promise<Result>) {
  const portal = await startPortal(reply);
  const lines: string[] = [];
  const exit = await exitOf(() => run(portal.url, (line) => lines.push(line)));
  return { exit, lines, seen: portal.seen };
}

/** The numbered steps' verdict lines (not the Start line). */
const numbered = (lines: string[]) => verdicts(lines).filter((line) => /^(PASS|FAIL) +\d+\. /.test(line));
const sorted = (values: readonly string[]) => [...values].sort();

/** The run stopped at `step` and exit 1: every step before it passed, none after it ran, and the summary says why. */
function expectStoppedAt(r: { exit: { code: number; summary: string }; lines: string[] }, title: string, step: number, says: string): void {
  expect(r.exit.code).toBe(1);
  expect(r.exit.summary).toMatch(new RegExp(`^FAIL: ${title} on test stopped at step ${step} \\(`));
  expect(verdicts(r.lines).at(-1)).toMatch(new RegExp(`^FAIL +${step}\\. `));
  expect(verdicts(r.lines).slice(0, -1).every((line) => line.startsWith('PASS'))).toBe(true);
  expect(numbered(r.lines)).toHaveLength(step);
  // The reason is in the summary line, which names the step and says why it failed: not in a note of an earlier step.
  expect(r.exit.summary).toContain(says);
}

// A world answers as the real services do. A tamper makes one answer wrong, to show that the runner watches that answer:
// it gets the request and the answer the world gave, and answers something else.
type Tamper = (req: Seen, answer: Reply) => Reply;
type Doc = Record<string, unknown>;
type Match = (req: Seen) => boolean;
const NO_TAMPER: Tamper = (_req, answer) => answer;
/** Requests to `path` (any query), by `who` when named. */
const on = (path: string, who?: string): Match => (req) => req.path.split('?')[0] === path && (who === undefined || req.persona === who);
/** Changes the body of the answers to the requests `match` accepts, keeping their status. */
const rewrite = (match: Match, change: (body: Doc, req: Seen) => unknown): Tamper => (req, [status, body]) => [status, match(req) ? change(body as Doc, req) : body];
/** Changes the status of the answers to the requests `match` accepts, keeping their body. */
const restatus = (match: Match, status: number): Tamper => (req, [was, body]) => [match(req) ? status : was, body];
/** Answers `reply` instead, whatever the world said, to the requests `match` accepts. */
const answer = (match: Match, reply: Reply): Tamper => (req, was) => (match(req) ? reply : was);
/** Applies `tamper` to the `n`th request `match` accepts only, counting from 1. */
function nthOf(n: number, match: Match, tamper: Tamper): Tamper {
  let counted = 0;
  return (req, was) => (match(req) && ++counted === n ? tamper(req, was) : was);
}
/** Drops the events of the decision-panel feed that `keep` refuses. */
const keeping = (keep: (event: Doc) => boolean): Tamper => rewrite(on('/api/events'), (body) => ({ ...body, events: (body.events as Doc[]).filter(keep) }));
const listed = (body: Doc, key: string) => body[key] as Doc[];

describe('the shared helpers of the new runners', () => {
  const failure = (fn: () => void): string => {
    try {
      fn();
    } catch (error) {
      if (error instanceof StepError) return error.message;
      throw error;
    }
    return '';
  };

  it('expectSameItems accepts the same items in any order, and says what is missing and what is extra', () => {
    expect(failure(() => expectSameItems('the list', ['b', 'a', 'a'], ['a', 'a', 'b']))).toBe('');
    expect(failure(() => expectSameItems('the list', ['a'], ['a', 'b']))).toBe('the list lacks b');
    expect(failure(() => expectSameItems('the list', ['a', 'c'], ['a']))).toBe('the list also has c');
    expect(failure(() => expectSameItems('the list', ['a', 'c'], ['a', 'b']))).toBe('the list lacks b and also has c');
  });

  it('expectSameItems counts repeats: an item listed twice is not the same as listed once', () => {
    expect(failure(() => expectSameItems('the list', ['a', 'a'], ['a']))).toBe('the list also has a');
    expect(failure(() => expectSameItems('the list', ['a'], ['a', 'a']))).toBe('the list lacks a');
  });

  it('awaitResetState could not run, never fail, when the PDP never shows the reset state', async () => {
    // The PDP lets Merry view EAN-1001 although the reset took Merry's roles away: the reset has not reached it.
    const portal = await startPortal(() => [200, { results: [{ allow: true }], ms: 1 }]);
    const expected: Expected[] = [{ user: 'merry', action: 'view', type: 'ean', key: 'EAN-1001', tenant: 'shire-freight', expect: false }];

    const result = await runScenario({ title: 'demo', profile: 'test', portal: new Api('portal', portal.url), reset: pass, log: () => undefined }, async (run) => {
      await awaitResetState(run, new Api('portal', portal.url), expected, { timeoutMs: 40, intervalMs: 5 });
    });

    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toMatch(/^demo stopped at the start check \(the PDP shows the reset state\): after \d+\.\d s the PDP still answers merry view ean:EAN-1001@shire-freight: expected deny, got allow: the reset has not reached it$/);
  });
});

describe('S2 runner', () => {
  const rehearseS2 = async (bugs?: S2Bugs, tamper: Tamper = NO_TAMPER) => {
    const world = s2World(bugs);
    return { ...(await rehearse((req) => tamper(req, world.reply(req)), (url, log) => runS2(env(url), { reset: pass, log }))), world };
  };

  it('passes all ten checks against a portal that answers as S2 expects', async () => {
    const { exit, lines, seen, world } = await rehearseS2();

    expect(exit.code).toBe(0);
    expect(exit.summary).toMatch(/^PASS: S2 on test: all 10 steps passed in /);
    expect(verdicts(lines)[0]).toMatch(/^PASS +Start: /);
    expect(numbered(lines)).toHaveLength(10);
    expect(verdicts(lines).every((line) => line.startsWith('PASS'))).toBe(true);
    // Sam's grants in order, then the repeat of the first, all as Sam.
    const grants = seen.filter((r) => r.method === 'POST' && r.path === '/api/s2/grants');
    expect(grants.map((r) => [r.persona, r.body])).toEqual([
      ['sam', { user: 'merry', role: 'shipper', resource: 'ean:EAN-1001' }],
      ['sam', { user: 'merry', role: 'shipper', resource: 'ean:EAN-1002' }],
      ['sam', { user: 'merry', role: 'account_manager', resource: 'account:CA-1001-B' }],
      ['sam', { user: 'merry', role: 'location_operator', resource: 'location:LOC-BYWATER' }],
      ['sam', { user: 'merry', role: 'location_operator', resource: 'location:LOC-FROGMORTON' }],
      ['sam', { user: 'merry', role: 'shipper', resource: 'ean:EAN-1001' }],
    ]);
    // Merry's grid is read as Merry; the forged grant goes through the console's tester, which takes no input.
    const grids = seen.filter((r) => r.path === '/api/s2/permissions/merry');
    expect(grids.length).toBeGreaterThanOrEqual(2);
    expect(grids.every((r) => r.persona === 'merry')).toBe(true);
    expect(seen.filter((r) => r.path === '/api/s2/forged-grant')).toEqual([{ method: 'POST', path: '/api/s2/forged-grant', body: undefined }]);
    // The one removal is Frogmorton's depot, and it is the only role gone at the end.
    expect(seen.filter((r) => r.method === 'DELETE').map((r) => [r.persona, r.body])).toEqual([
      ['sam', { user: 'merry', role: 'location_operator', resource: 'location:LOC-FROGMORTON' }],
      ['sam', { user: 'merry', role: 'location_operator', resource: 'location:LOC-FROGMORTON' }],
    ]);
    expect(sorted(world.held)).toEqual(['account_manager account:CA-1001-B', 'location_operator location:LOC-BYWATER', 'shipper ean:EAN-1001', 'shipper ean:EAN-1002']);
  });

  const GRID = on('/api/s2/permissions/merry');
  const rowsOf = (body: Doc) => listed(body, 'rows');
  const editRow = (resource: string, change: (row: Doc) => Doc) => rewrite(GRID, (body) => ({ rows: rowsOf(body).map((row) => (row.resource === resource ? change(row) : row)) }));
  const MERRYS_ASSIGNMENTS = '/api/s2/members/merry/assignments';

  it.each<{ name: string; step: number; says: string; bugs?: S2Bugs; tamper?: Tamper }>([
    // The world misbehaves.
    { name: "Sam's team offers the integration sandbox", bugs: { sandboxOffered: true }, step: 1, says: "Sam's Team access also has shipper ean:EAN-SANDBOX" },
    { name: 'a repeated grant lists the assignment twice', bugs: { repeatDuplicates: true }, step: 5, says: "Merry's roles after the repeat also has shipper ean:EAN-1001" },
    { name: 'a grant is written before the check that guards it', bugs: { writeBeforeCheck: true }, step: 2, says: 'was written before Permit was asked' },
    { name: 'Hobbiton shows view_billing', bugs: { hobbitonBilling: true }, step: 6, says: "Merry's actions on account:CA-1001-A also has view_billing" },
    { name: "Bag End shows in Merry's grid", bugs: { bagEndShown: true }, step: 7, says: "Merry's grid also has location:LOC-BAGEND" },
    { name: 'Frodo can make EAN admins', bugs: { frodoMayMakeAdmins: true }, step: 8, says: "Frodo's Team access also has account_admin ean:EAN-1001" },
    { name: 'the forged grant is accepted', bugs: { forgedAccepted: true }, step: 9, says: "the portal's status for the forged grant is 201, expected 403" },
    { name: 'the forged grant is refused but still written', bugs: { forgedStillWrites: true }, step: 9, says: 'the refused grant still wrote to Permit: assign shipper on ean:EAN-1002 to merry' },
    { name: "the forged grant changes Merry's roles without a write", bugs: { forgedWritesSilently: true }, step: 9, says: "Merry's roles after the forged grant also has account_admin ean:EAN-1002" },
    { name: "a removed grant stays in Merry's grid", bugs: { roleSurvivesRemoval: true }, step: 10, says: "Merry's grid after the removal also has location:LOC-FROGMORTON" },
    // One answer is wrong.
    { name: 'Merry is not among the people Sam can pick', step: 1, says: "Sam's team does not list Merry",
      tamper: rewrite(on('/api/s2/team', 'sam'), (body) => ({ ...body, members: [{ key: 'sam', name: 'Sam' }] })) },
    { name: 'the portal reports a fresh grant as no change', step: 2, says: 'reports 0 ms on the PDP',
      tamper: rewrite((req) => req.method === 'POST' && req.path === '/api/s2/grants', () => ({ ms: 0 })) },
    { name: "the decision panel has no check for Sam's grant", step: 2, says: 'the decision panel has no allowed grant_shipper check as sam on ean:EAN-1001',
      tamper: keeping((event) => event.kind !== 'check') },
    { name: "the decision panel has no write for Sam's grant", step: 2, says: 'the decision panel has no confirmed write "assign shipper on ean:EAN-1001 to merry"',
      tamper: keeping((event) => event.kind !== 'write') },
    { name: "Team access forgets Merry's operator role on Frogmorton depot", step: 4, says: "Merry's roles in Sam's Team access lacks location_operator location:LOC-FROGMORTON",
      tamper: rewrite(on(MERRYS_ASSIGNMENTS, 'sam'), (body) => ({ assignments: listed(body, 'assignments').filter((a) => a.resource !== 'location:LOC-FROGMORTON') })) },
    { name: "Hobbiton's row lists no role", step: 6, says: "Merry's roles on account:CA-1001-A lacks shipper", tamper: editRow('account:CA-1001-A', (row) => ({ ...row, roles: [] })) },
    { name: "Hobbiton's row lists view_billing, which no decision allows", step: 6, says: "Merry's actions on account:CA-1001-A also has view_billing",
      tamper: editRow('account:CA-1001-A', (row) => ({ ...row, actions: [...(row.actions as string[]), 'view_billing'] })) },
    { name: 'the PDP lets Merry view billing on Hobbiton, which the grid does not list', step: 6, says: 'merry view_billing account:CA-1001-A@shire-freight: expected deny, got allow',
      // The first of Merry's bulk checks is the start check, which must see the reset state; the second is step 6's.
      tamper: nthOf(2, on('/api/checks/bulk', 'merry'), rewrite(on('/api/checks/bulk', 'merry'), (body) => ({ ...body, results: listed(body, 'results').map(() => ({ allow: true })) }))) },
    { name: "Frogmorton depot's row lists no operate", step: 7, says: "Merry's actions on location:LOC-FROGMORTON lacks operate",
      tamper: editRow('location:LOC-FROGMORTON', (row) => ({ ...row, actions: ['view'] })) },
    { name: "Merry's grid has a stray row", step: 7, says: "Merry's grid also has shipment:SHP-77001",
      tamper: rewrite(GRID, (body) => ({ rows: [...rowsOf(body), { resource: 'shipment:SHP-77001', name: 'SHP-77001', roles: ['viewer'], actions: ['view'] }] })) },
    { name: "Frodo's Team access offers account admin (the form only)", step: 8, says: "Frodo's Team access also has account_admin ean:EAN-1001",
      tamper: rewrite(on('/api/s2/team', 'frodo'), (body) => ({ ...body, grantable: [...listed(body, 'grantable'), { role: 'account_admin', resource: 'ean:EAN-1001', name: 'EAN-1001', parent: null }] })) },
    { name: "Frodo sees Merry's shipper role on EAN-1002", step: 8, says: "Merry's roles in Frodo's Team access also has shipper ean:EAN-1002",
      tamper: rewrite(on(MERRYS_ASSIGNMENTS, 'frodo'), (body) => ({ assignments: [...listed(body, 'assignments'), { role: 'shipper', resource: 'ean:EAN-1002' }] })) },
    { name: 'the forged grant answers 200', step: 9, says: "the portal's status for the forged grant is 200, expected 403",
      tamper: rewrite(on('/api/s2/forged-grant'), (body) => ({ ...body, status: 200 })) },
    { name: "the forged grant is refused in other words than Permit's", step: 9, says: "the portal's reason is Something went wrong, expected Permit denied grant_shipper on ean:EAN-1002.",
      tamper: rewrite(on('/api/s2/forged-grant'), (body) => ({ ...body, body: { error: 'Something went wrong', decision: 'deny' } })) },
    { name: "the decision panel has no DENIED check for Frodo's grant", step: 9, says: 'the decision panel has no DENIED grant_shipper check as frodo on ean:EAN-1002',
      tamper: keeping((event) => event.user !== 'frodo') },
    { name: 'the portal reports a removal as no change', step: 10, says: 'the removal reports 0 ms on the PDP',
      tamper: rewrite((req) => req.method === 'DELETE', () => ({ ms: 0 })) },
    { name: "Merry's grid still lists Frogmorton depot after the removal (the grid only)", step: 10, says: "Merry's grid after the removal also has location:LOC-FROGMORTON",
      tamper: rewrite(GRID, (body) => ({ rows: rowsOf(body).some((row) => row.resource === 'location:LOC-FROGMORTON') ? rowsOf(body) : [...rowsOf(body), { resource: 'location:LOC-FROGMORTON', name: 'Frogmorton depot', roles: ['location_operator'], actions: ['operate', 'view'] }] })) },
    { name: 'a repeated removal is reported as a change', step: 10, says: 'the milliseconds a repeated removal reports is 900, expected 0',
      tamper: nthOf(2, (req) => req.method === 'DELETE', () => [200, { ms: 900 }]) },
  ])('stops at step $step and exits 1 when $name', async ({ bugs, tamper, step, says }) => {
    expectStoppedAt(await rehearseS2(bugs, tamper), 'S2', step, says);
  });

  it('a portal that cannot be asked means the scenario could not run, never a pass', async () => {
    const portal = await startPortal((req) => unexpected(req));
    await new Promise((resolve) => servers.pop()?.close(resolve));

    const exit = await exitOf(() => runS2(env(portal.url), { reset: pass, log: () => undefined }));

    expect(exit.code).toBe(2);
    expect(exit.summary).toMatch(/^COULD NOT RUN: S2 on test did not start/);
  });
});

describe('S5 runner', () => {
  const rehearseS5 = async (bugs?: S5Bugs, tamper: Tamper = NO_TAMPER) => {
    const world = s5World(bugs);
    return { ...(await rehearse((req) => tamper(req, world.reply(req)), (url, log) => runS5(env(url), { reset: pass, log }))), world };
  };

  it('passes all ten checks against a portal that answers as S5 expects', async () => {
    const { exit, lines, seen, world } = await rehearseS5();

    expect(exit.code).toBe(0);
    expect(exit.summary).toMatch(/^PASS: S5 on test: all 10 steps passed in /);
    expect(verdicts(lines)[0]).toMatch(/^PASS +Start: /);
    expect(numbered(lines)).toHaveLength(10);
    expect(verdicts(lines).every((line) => line.startsWith('PASS'))).toBe(true);
    // The runner is Pippin and Sam; the connector only ever acts through the console's run call, which holds its credential.
    const runs = seen.filter((r) => r.path === '/api/integrations/shire-erp/run');
    expect(runs[0]?.body).toEqual({ op: 'create', ean: 'EAN-SANDBOX' });
    expect(runs.every((r) => r.persona === undefined && r.authorization === undefined)).toBe(true);
    // The only direct calls to the integration API are the two refused ones: no credential, and one nobody issued.
    const direct = seen.filter((r) => r.path.startsWith('/api/integration/'));
    expect(direct.map((r) => [r.method, r.path, r.authorization])).toEqual([
      ['POST', '/api/integration/shipments', undefined],
      ['POST', '/api/integration/shipments', `Bearer ${'0'.repeat(64)}`],
    ]);
    // Nothing the runner sent, printed or summed up carries the client secret.
    expect(JSON.stringify(seen)).not.toContain(S5_SECRET);
    expect(`${lines.join('\n')}\n${exit.summary}`).not.toContain(S5_SECRET);
    // Revoked at the end: no role is left on the connector.
    expect(world.scope).toEqual([]);
  });

  const LIST = on('/api/s5/integrations');
  /** Changes the connector's card in the answers of the `n`th request of `who` for the list, counting from 1. */
  const card = (change: (card: Doc) => Doc, who: string, n?: number): Tamper => {
    const edit = rewrite(on('/api/s5/integrations', who), (body) => ({ ...body, integrations: listed(body, 'integrations').map(change) }));
    return n === undefined ? edit : nthOf(n, on('/api/s5/integrations', who), edit);
  };
  const scopeOf = (c: Doc) => listed(c, 'scope');
  const RUN = on('/api/integrations/shire-erp/run');
  /** The console's run answers for one call of the connector. */
  const runOf = (op: string, ean: string): Match => (req) => RUN(req) && (req.body as Doc).op === op && (req.body as Doc).ean === ean;
  const refused = (op: string, ean: string, status = 403): Reply => [200, { status, body: { error: `Permit denied ${op === 'create' ? 'create_shipment' : 'view'} on ean:${ean}.`, decision: 'deny' } }];
  const APPROVE = (who: string): Match => (req) => req.method === 'POST' && req.persona === who && req.path.endsWith('/approve');
  const RECENT_DENIED = [1, 2, 3, 4, 5].map((at) => ({ action: 'view', resource: 'ean:EAN-1001', allow: false, at }));

  it.each<{ name: string; step: number; says: string; bugs?: S5Bugs; tamper?: Tamper }>([
    // The world misbehaves.
    { name: 'the integration API accepts a credential it never issued', bugs: { acceptsAnyCredential: true }, step: 1, says: "the integration API's status for a credential nobody issued is 201, expected 401" },
    { name: 'the integrations list carries the client secret', bugs: { leaksSecret: true }, step: 1, says: "the client secret appears in pippin's integrations list" },
    { name: 'production works before anyone approves it', bugs: { productionBeforeApproval: true }, step: 3, says: "the connector's create on EAN-1001 answered 201, expected 403" },
    { name: 'Pippin can approve their own request', bugs: { pippinMayApprove: true }, step: 5, says: 'as pippin answered 200, expected 409' },
    { name: 'Frodo, who may not approve integrations, can', bugs: { frodoMayApprove: true }, step: 5, says: 'as frodo answered 200, expected 403' },
    { name: "the connector's checks reach the panel without its name", bugs: { noConnectorLabel: true }, step: 7, says: 'the subject the decision panel shows is missing, expected Shire ERP connector' },
    { name: 'the connector may create on EAN-1002', bugs: { ean1002Open: true }, step: 8, says: "the connector's create on EAN-1002 answered 201, expected 403" },
    { name: 'view-only leaves the create role', bugs: { viewOnlyKeepsCreate: true }, step: 9, says: "the connector's scope also has integration_client ean:EAN-1001" },
    { name: 'revoking leaves the sandbox role', bugs: { revokeKeepsSandbox: true }, step: 10, says: "the connector's create on EAN-SANDBOX answered 201, expected 403" },
    { name: "Sam's card lists no recent calls", bugs: { noRecentCalls: true }, step: 10, says: "the number of calls on Sam's card is 0, expected 10" },
    // One answer is wrong.
    { name: 'a second registration of the same key is accepted', step: 1, says: 'the status of a second registration of the same key is 201, expected 409',
      tamper: restatus((req) => req.method === 'POST' && req.path === '/api/s5/integrations', 201) },
    { name: 'the client secret is not 64 hexadecimal characters', step: 1, says: 'the client secret is not 64 hexadecimal characters',
      tamper: rewrite((req) => req.method === 'POST' && req.path === '/api/s5/integrations', (body) => ({ ...body, client_secret: 'abc123' })) },
    { name: "the registration gives the connector a role beyond the sandbox", step: 1, says: "the connector's scope also has integration_client ean:EAN-1001",
      tamper: rewrite((req) => req.method === 'POST' && req.path === '/api/s5/integrations', (body) => ({ ...body, integration: { ...(body.integration as Doc), scope: [...scopeOf(body.integration as Doc), { role: 'integration_client', resource: 'ean:EAN-1001' }] } })) },
    { name: 'the integration API lets a call with no credential in', step: 1, says: "the integration API's status without a credential is 201, expected 401",
      tamper: answer((req) => req.path === '/api/integration/shipments' && req.authorization === undefined, [201, { key: 'SHP-1' }]) },
    { name: 'the integration API refuses a stranger in other words', step: 1, says: "the integration API's reason is Forbidden, expected Unknown client credential",
      tamper: answer((req) => req.path === '/api/integration/shipments' && req.authorization !== undefined, [401, { error: 'Forbidden' }]) },
    { name: 'the sandbox create is refused', step: 2, says: "the connector's create on EAN-SANDBOX answered 403, expected 201",
      tamper: answer(runOf('create', 'EAN-SANDBOX'), refused('create', 'EAN-SANDBOX')) },
    { name: 'a list on EAN-1001 works before approval', step: 3, says: "the connector's list on EAN-1001 answered 200, expected 403",
      tamper: answer(runOf('list', 'EAN-1001'), [200, { status: 200, body: { shipments: [] } }]) },
    { name: "Pippin's approvals list the request", step: 4, says: "pippin's approvals list the request, and pippin may not decide it",
      tamper: answer(on('/api/approvals', 'pippin'), [200, { requests: [{ id: 'req-test-5', status: 'pending' }] }]) },
    { name: "Frodo's approvals list the request", step: 4, says: "frodo's approvals list the request, and frodo may not decide it",
      tamper: answer(on('/api/approvals', 'frodo'), [200, { requests: [{ id: 'req-test-5', status: 'pending' }] }]) },
    { name: "Pippin's approval is refused in other words", step: 5, says: "the portal's reason is Something else, expected A request cannot be approved",
      tamper: answer(APPROVE('pippin'), [409, { error: 'Something else' }]) },
    { name: "Frodo's approval is refused by something other than Permit", step: 5, says: "Permit's reason is Forbidden, expected Permit denied approve_integration on ean:EAN-1001.",
      tamper: answer(APPROVE('frodo'), [403, { error: 'Forbidden' }]) },
    { name: 'the request is no longer pending after two refused approvals', step: 5, says: 'the request is no longer pending after two refused approvals',
      tamper: nthOf(2, on('/api/approvals', 'sam'), answer(() => true, [200, { requests: [{ id: 'req-test-5', status: 'approved' }] }])) },
    { name: 'the approval reports no change on the PDP', step: 6, says: 'the approval reports 0 ms on the PDP, so no role was written',
      tamper: rewrite(APPROVE('sam'), (body) => ({ ...body, ms: 0 })) },
    { name: 'the approval leaves the connector without its role', step: 6, says: "the connector's scope lacks integration_client ean:EAN-1001",
      tamper: card((c) => ({ ...c, scope: scopeOf(c).filter((entry) => entry.resource !== 'ean:EAN-1001') }), 'sam') },
    { name: 'the PDP lets Pippin view EAN-1001', step: 6, says: 'pippin view ean:EAN-1001@shire-freight: expected deny, got allow',
      tamper: rewrite(on('/api/checks/bulk', 'pippin'), (body) => ({ ...body, results: listed(body, 'results').map(() => ({ allow: true })) })) },
    { name: 'Great Eagle systems hold no shipment after the create', step: 7, says: 'the shipments Great Eagle systems hold on EAN-1001 lacks SHP-80002',
      tamper: answer((req) => req.path === '/api/shipments?ean=EAN-1001', [200, []]) },
    { name: 'Great Eagle systems hold a shipment from the denied create', step: 8, says: 'the shipments Great Eagle systems hold on EAN-1002 also has SHP-9',
      tamper: answer((req) => req.path === '/api/shipments?ean=EAN-1002', [200, [{ key: 'SHP-9' }]]) },
    { name: 'the PDP does not let Sam view EAN-1002', step: 8, says: 'sam view ean:EAN-1002@shire-freight: expected allow, got deny',
      tamper: rewrite(on('/api/checks/bulk', 'sam'), (body) => ({ ...body, results: listed(body, 'results').map(() => ({ allow: false })) })) },
    { name: 'the view-only swap reports no change', step: 9, says: 'the swap reports 0 ms on the PDP, so no role changed',
      tamper: rewrite((req) => on('/api/s5/integrations/shire-erp/scope')(req) && (req.body as Doc).level === 'read', () => ({ ms: 0 })) },
    { name: 'after the swap the card still lists the create role', step: 9, says: "the connector's scope also has integration_client ean:EAN-1001",
      tamper: card((c) => (scopeOf(c).some((e) => e.role === 'integration_reader') ? { ...c, scope: [...scopeOf(c), { role: 'integration_client', resource: 'ean:EAN-1001' }] } : c), 'sam') },
    { name: 'a list on EAN-1001 is refused after the swap', step: 9, says: "the connector's list on EAN-1001 answered 403, expected 200",
      tamper: nthOf(2, runOf('list', 'EAN-1001'), answer(() => true, refused('list', 'EAN-1001'))) },
    { name: 'the list on EAN-1001 does not show the shipment the connector created', step: 9, says: 'the list on EAN-1001 does not show SHP-80002',
      tamper: nthOf(2, runOf('list', 'EAN-1001'), rewrite(() => true, (body) => ({ ...body, body: { shipments: [] } }))) },
    // The client secret must never come back, wherever the runner looks: each place it reads is held to that.
    { name: "Great Eagle systems' registry lists the secret", step: 1, says: "the client secret appears in Great Eagle systems' registry",
      tamper: answer(on('/api/integrations'), [200, [{ key: 'shire-erp', client_secret: S5_SECRET }]]) },
    { name: 'the decision panel carries the secret', step: 1, says: "the client secret appears in the portal's decision-panel feed",
      tamper: rewrite(on('/api/events', 'pippin'), (body) => ({ ...body, events: [...listed(body, 'events'), { id: 999, kind: 'check', note: S5_SECRET }] })) },
    { name: 'a second registration answers with the secret', step: 1, says: 'the client secret appears in the refusal of a second registration',
      tamper: nthOf(2, (req) => req.method === 'POST' && req.path === '/api/s5/integrations', answer(() => true, [409, { error: S5_SECRET }])) },
    { name: "the connector's run answer carries the secret", step: 2, says: "the client secret appears in the connector's run answer",
      tamper: rewrite(RUN, (body) => ({ ...body, leaked: S5_SECRET })) },
    { name: "Sam's card carries the secret at the end", step: 10, says: "the client secret appears in Sam's card",
      tamper: card((c) => ({ ...c, leaked: S5_SECRET }), 'sam', 6) },
    { name: 'the decision panel carries the secret at the end', step: 10, says: "the client secret appears in the portal's decision-panel feed",
      tamper: rewrite(on('/api/events', 'sam'), (body) => ({ ...body, events: [...listed(body, 'events'), { id: 999, kind: 'check', note: S5_SECRET }] })) },
    { name: "Great Eagle systems' registry lists the secret at the end", step: 10, says: "the client secret appears in Great Eagle systems' registry",
      tamper: nthOf(2, on('/api/integrations'), answer(() => true, [200, [{ key: 'shire-erp', client_secret: S5_SECRET }]])) },
    // Sam's card is read five times by now (start, registration, approval, view-only, and the first read of the revocation):
    // the fifth read lists the EANs to revoke, and the sixth is what Sam reviews afterwards.
    { name: 'the card lists an EAN nobody gave the connector', step: 10, says: 'the EANs the connector holds a role on also has EAN-1002',
      tamper: card((c) => ({ ...c, scope: [...scopeOf(c), { role: 'integration_client', resource: 'ean:EAN-1002' }] }), 'sam', 5) },
    { name: 'after the revocation the card still lists a role', step: 10, says: "the connector's scope also has integration_reader ean:EAN-1001",
      tamper: card((c) => ({ ...c, scope: [{ role: 'integration_reader', resource: 'ean:EAN-1001' }] }), 'sam', 6) },
    { name: 'after the revocation the request is not recorded as revoked', step: 10, says: "the production request's status is approved, expected revoked",
      tamper: card((c) => ({ ...c, requests: listed(c, 'requests').map((r) => ({ ...r, status: 'approved' })) }), 'sam', 6) },
    { name: "Sam's card lists the calls oldest first", step: 10, says: "Sam's card does not list the calls newest first",
      tamper: card((c) => ({ ...c, recent: [...RECENT_DENIED, ...RECENT_DENIED.map((call) => ({ ...call, allow: true, at: call.at + 10 }))] }), 'sam', 6) },
    { name: "Sam's card lists a call after the revocation as allowed", step: 10, says: "Sam's card does not show the five calls made after the revocation as denied",
      tamper: card((c) => ({ ...c, recent: listed(c, 'recent').map((call, i) => (i === 0 ? { ...call, allow: true } : call)) }), 'sam', 6) },
    { name: "Sam's card lists no call that was allowed", step: 10, says: "Sam's card shows no call that was allowed",
      tamper: card((c) => ({ ...c, recent: listed(c, 'recent').map((call) => ({ ...call, allow: false })) }), 'sam', 6) },
  ])('stops at step $step and exits 1 when $name, and never prints the secret', async ({ bugs, tamper, step, says }) => {
    const result = await rehearseS5(bugs, tamper);

    expectStoppedAt(result, 'S5', step, says);
    expect(`${result.lines.join('\n')}\n${result.exit.summary}`).not.toContain(S5_SECRET);
  });

  it('an empty client secret is a failure of step 1, not a filter that garbles every line', async () => {
    const result = await rehearseS5({}, rewrite((req) => req.method === 'POST' && req.path === '/api/s5/integrations', (body) => ({ ...body, client_secret: '' })));

    expectStoppedAt(result, 'S5', 1, 'the client secret is not 64 hexadecimal characters');
    expect(result.lines).toContain('        the client secret is not 64 hexadecimal characters');
    expect(result.lines.join('\n')).not.toContain('[client secret]');
  });

  it('shows the filter in place of the client secret when the portal quotes it in an error', async () => {
    // The portal answers the list with an error that carries the secret: the runner's failure must not.
    const quoted = answer(on('/api/s5/integrations', 'pippin'), [500, { error: `boom ${S5_SECRET}` }]);
    const result = await rehearseS5({}, (req, was) => (req.persona === 'pippin' && LIST(req) && req.method === 'GET' ? quoted(req, was) : was));

    expectStoppedAt(result, 'S5', 1, "pippin answered 500, expected 200: boom [client secret]");
    expect(`${result.lines.join('\n')}\n${result.exit.summary}`).not.toContain(S5_SECRET);
  });

  it('could not run, never fail, when the reset left a connector registered', async () => {
    const { exit, lines } = await rehearseS5({}, rewrite(on('/api/s5/integrations', 'sam'), () => ({ integrations: [{ key: 'old-erp' }] })));

    expect(exit.code).toBe(2);
    expect(exit.summary).toMatch(/^COULD NOT RUN: S5 on test stopped at the start check \(no connector is registered\): the reset left old-erp registered$/);
    expect(numbered(lines)).toHaveLength(0);
  });
});

describe('S8 runner', () => {
  const FRODO_CHANGE: DecisionChange = { at: '2026-10-07T15:53:25+00:00', user: 'frodo', action: 'view_billing', resource: 'account:CA-1001-A', then: true, now: false };
  const PIPPIN_CHANGE: DecisionChange = { at: '2026-10-07T15:53:17+00:00', user: 'pippin', action: 'view_billing', resource: 'account:CA-1001-A', then: false, now: true };
  const report = (changed: DecisionChange[]): ReplayReport => ({ total: 404, unchanged: 404 - changed.length, changed, unreplayable: 0, pages: 5 });
  type Trail = Partial<AuditTrail>;

  /** Runs S8 against the legacy world, with the audit trail replaced by `trail` (the audit log lists the run at once, and two decisions change). */
  const rehearseS8 = async (bugs: S8Bugs = {}, trail: Trail = {}, tamper: Tamper = NO_TAMPER) => {
    const world = s8World(bugs);
    const windows: Array<{ since: number; until: number }> = [];
    const audited: Array<[string, number]> = [];
    const result = await rehearse((req) => tamper(req, world.reply(req)), (url, log) => runS8(env(url), {
      reset: pass, log, auditWaitMs: 100, auditPollMs: 5,
      audited: (user, since) => {
        audited.push([user, since]);
        return (trail.audited ?? (async () => true))(user, since);
      },
      replay: (window) => {
        windows.push(window);
        return (trail.replay ?? (async () => report([PIPPIN_CHANGE, FRODO_CHANGE])))(window);
      },
    }));
    return { ...result, world, windows, audited };
  };

  it('passes all ten checks against a legacy app that answers as S8 expects', async () => {
    const before = Date.now();
    const { exit, lines, seen, world, windows, audited } = await rehearseS8();

    expect(exit.code).toBe(0);
    expect(exit.summary).toMatch(/^PASS: S8 on test: all 10 steps passed in /);
    expect(verdicts(lines)[0]).toMatch(/^PASS +Start: /);
    expect(numbered(lines)).toHaveLength(10);
    expect(verdicts(lines).every((line) => line.startsWith('PASS'))).toBe(true);
    // The mapping is fixed to version 2 once, and synced once, before the revocation.
    expect(seen.filter((r) => r.path === '/api/legacy/mapping').map((r) => r.body)).toEqual([{ version: 2 }]);
    const order = seen.map((r) => `${r.method} ${r.path}`);
    expect(order.filter((entry) => entry === 'POST /api/legacy/sync')).toHaveLength(1);
    expect(order.indexOf('POST /api/legacy/sync')).toBeLessThan(order.indexOf('DELETE /api/s2/grants'));
    // The modes in order: both, Permit, back to both.
    expect(seen.filter((r) => r.path === '/api/legacy/mode').map((r) => r.body)).toEqual([{ mode: 'both' }, { mode: 'permit' }, { mode: 'both' }]);
    // Frodo is revoked through S2's API as Sam, never in the legacy table.
    expect(seen.filter((r) => r.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: '/api/s2/grants', persona: 'sam', body: { user: 'frodo', role: 'account_admin', resource: 'ean:EAN-1001' } },
    ]);
    expect(world.permit).toEqual({ frodo: false, pippin: true });
    expect(world.state).toMatchObject({ mode: 'both', mappingVersion: 2, validations: 2 });
    // The audit log is read for Frodo's decisions from the revocation on, and the replay asks for the run's own window once.
    expect(audited).toHaveLength(1);
    expect(audited[0]?.[0]).toBe('frodo');
    expect(audited[0]?.[1]).toBeGreaterThanOrEqual(before);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.since).toBeGreaterThanOrEqual(before - 5_000);
    expect(windows[0]?.since).toBeLessThanOrEqual(audited[0]?.[1] ?? 0);
    expect(windows[0]?.until).toBeGreaterThanOrEqual(audited[0]?.[1] ?? Number.POSITIVE_INFINITY);
  });

  const VALIDATE = on('/api/legacy/validate');
  const STATE = on('/api/legacy/state');
  const REQUEST = (user: string): Match => (req) => req.path === '/api/legacy/requests' && (req.body as Doc).user === user;
  const SYNC = on('/api/legacy/sync');
  const MODE = (mode: string): Match => (req) => req.method === 'PUT' && req.path === '/api/legacy/mode' && (req.body as Doc).mode === mode;
  const groups = (body: Doc) => listed(body.summary as Doc, 'groups');
  /** Changes the comparison's groups in the answer to the `n`th validation. */
  const regroup = (n: number, change: (groups: Doc[]) => Doc[]): Tamper =>
    nthOf(n, VALIDATE, rewrite(VALIDATE, (body) => ({ ...body, summary: { ...(body.summary as Doc), groups: change(groups(body)) } })));
  const grantsOf = (body: Doc) => listed(body, 'grants');

  it.each<{ name: string; step: number; says: string; bugs?: S8Bugs; tamper?: Tamper }>([
    // The world misbehaves.
    { name: 'shadow mode enforces Permit instead of the legacy app', bugs: { shadowEnforcesPermit: true }, step: 1, says: 'pippin on CA-1001-A: what the legacy app enforced is false, expected true' },
    { name: 'the comparison cannot ask Permit', bugs: { validationCannotAsk: true }, step: 2, says: 'Permit could not check 195 of 195 requests: The PDP did not answer' },
    { name: 'the sync fails', bugs: { syncFails: true }, step: 3, says: 'answered 502, expected 200: The PDP did not confirm this change within 5 seconds.' },
    { name: 'the sync writes nothing for Pippin', bugs: { syncWritesNothing: true }, step: 3, says: "what the sync did with Pippin's grant is unchanged, expected written" },
    { name: 'the sync says it wrote the role but the PDP never holds it', bugs: { syncNeverReachesPdp: true }, step: 3, says: 'pippin view_billing account:CA-1001-A@shire-freight: expected allow, got deny' },
    { name: 'both mode lets the legacy answer through', bugs: { bothFailsOpen: true }, step: 5, says: 'fatty on CA-1001-A: what the legacy app enforced is true, expected false' },
    { name: "Frodo's revocation never reaches Permit", bugs: { revocationNeverArrives: true }, step: 7, says: "frodo on CA-1001-A: Permit's answer is true, expected false" },
    // One answer is wrong.
    { name: 'the legacy app starts in both mode', step: 1, says: 'the mode is both, expected shadow', tamper: rewrite(STATE, (body) => ({ ...body, mode: 'both' })) },
    { name: 'the legacy table lacks Fatty', step: 1, says: "the legacy app's users lacks fatty",
      tamper: nthOf(1, STATE, rewrite(STATE, (body) => ({ ...body, users: listed(body, 'users').filter((u) => u.key !== 'fatty') }))) },
    { name: "the first comparison lists someone else's mismatches", step: 2, says: 'the users with mismatches also has sam',
      tamper: regroup(1, (list) => [...list, { user: 'sam', count: 13 }]) },
    { name: "Pippin's mismatch is approved as well", step: 2, says: "Pippin's mismatches are unexpected: approved by is sam, expected missing",
      tamper: regroup(1, (list) => list.map((g) => (g.user === 'pippin' ? { ...g, expected: { reason: 'x', approved_by: 'sam' } } : g))) },
    { name: "Fatty's tightening is approved by someone else", step: 2, says: "the owner's approval of fatty's tightening is frodo, expected sam",
      tamper: regroup(1, (list) => list.map((g) => (g.user === 'fatty' ? { ...g, expected: { reason: 'x', approved_by: 'frodo' } } : g))) },
    { name: 'the mapping stays on version 1', step: 3, says: 'the mapping version is 1, expected 2',
      tamper: rewrite((req) => req.method === 'PUT' && req.path === '/api/legacy/mapping', (body) => ({ ...body, mappingVersion: 1 })) },
    { name: 'the sync lists a grant as failed', step: 3, says: 'the grants that failed is 1, expected 0',
      tamper: rewrite(SYNC, (body) => ({ ...body, grants: grantsOf(body).map((g, i) => (i === 0 ? { ...g, status: 'failed' } : g)) })) },
    { name: "the sync does not skip Lobelia's grants", step: 3, says: 'the grants the mapping skipped lacks lobelia, lobelia',
      tamper: rewrite(SYNC, (body) => ({ ...body, grants: grantsOf(body).map((g) => (g.user === 'lobelia' ? { ...g, status: 'written' } : g)) })) },
    { name: 'the sync counts one write only', step: 3, says: 'the grants written or already held is 1, expected 3',
      tamper: rewrite(SYNC, (body) => ({ ...body, written: 1, unchanged: 0 })) },
    { name: 'the second comparison lists an approved group of someone else', step: 4, says: 'the users with mismatches also has sam',
      tamper: regroup(2, (list) => [...list, { user: 'sam', count: 13, expected: { reason: 'x', approved_by: 'sam' } }]) },
    { name: "the second comparison leaves Fatty's group unapproved", step: 4, says: 'the unexpected mismatches is 1, expected 0',
      tamper: regroup(2, (list) => list.map((g) => (g.user === 'fatty' ? { user: g.user, count: g.count } : g))) },
    { name: 'Fatty passes in both mode', step: 5, says: 'fatty on CA-1001-A: what the legacy app enforced is true, expected false',
      tamper: rewrite(REQUEST('fatty'), (body) => ({ ...body, enforced: true })) },
    { name: 'the revocation reports no change', step: 6, says: 'the revocation reports 0 ms on the PDP, so no role was removed',
      tamper: rewrite((req) => req.method === 'DELETE', () => ({ ms: 0 })) },
    { name: "Frodo's accounts in the legacy table are gone", step: 7, says: "Frodo's accounts in the legacy table lacks EAN-1001",
      tamper: nthOf(2, STATE, rewrite(STATE, (body) => ({ ...body, users: listed(body, 'users').map((u) => (u.key === 'frodo' ? { ...u, accounts: [] } : u)) }))) },
    { name: "Sam is denied after Frodo's revocation", step: 7, says: "sam on CA-1001-B: Permit's answer is false, expected true",
      tamper: rewrite(REQUEST('sam'), (body) => (body.mode === 'both' ? { ...body, permit: false, enforced: false } : body)) },
    { name: 'the switch to Permit leaves the mode on both', step: 8, says: 'the mode is both, expected permit',
      tamper: rewrite(MODE('permit'), (body) => ({ ...body, mode: 'both' })) },
    { name: 'the rollback leaves the mode on Permit', step: 9, says: 'the mode is permit, expected both',
      tamper: nthOf(2, MODE('both'), rewrite(MODE('both'), (body) => ({ ...body, mode: 'permit' }))) },
  ])('stops at step $step and exits 1 when $name', async ({ bugs, tamper, step, says }) => {
    expectStoppedAt(await rehearseS8(bugs, {}, tamper), 'S8', step, says);
  });

  it('waits for the audit log to list the run by reading it, then replays once, and passes', async () => {
    let asked = 0;
    const { exit, lines, windows } = await rehearseS8({}, {
      audited: async () => {
        asked += 1;
        return asked >= 3;
      },
    });

    expect(exit.code).toBe(0);
    expect(asked).toBe(3);
    expect(windows).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/audit log lists the run's decisions \d+\.\d s after the revocation/);
  });

  it('fails at step 10 when the audit log never lists the run, without replaying anything', async () => {
    const result = await rehearseS8({}, { audited: async () => false });

    expectStoppedAt(result, 'S8', 10, "audit log lists no decision of frodo made since the revocation");
    expect(result.windows).toHaveLength(0);
  });

  it('fails at step 10 when no decision of Frodo would change, even if others would', async () => {
    expectStoppedAt(await rehearseS8({}, { replay: async () => report([PIPPIN_CHANGE]) }), 'S8', 10, 'would change for frodo');
  });

  it('fails at step 10 when the replay finds nothing changed', async () => {
    expectStoppedAt(await rehearseS8({}, { replay: async () => report([]) }), 'S8', 10, 'none of the 404 decisions');
  });

  it('could not run, never fail, when the audit log cannot be read: a failed read is not an empty one', async () => {
    const result = await rehearseS8({}, {
      audited: async () => {
        throw new Error('GET /v2/pdps/p/e/audit_logs answered 500');
      },
    });

    expect(result.exit.code).toBe(2);
    expect(result.exit.summary).toMatch(/^COULD NOT RUN: S8 on test stopped at step 10 /);
    expect(result.exit.summary).toContain("audit log could not be read: GET /v2/pdps/p/e/audit_logs answered 500");
    expect(numbered(result.lines)).toHaveLength(10);
  });

  it('could not run when the replay cannot ask the PDP', async () => {
    const result = await rehearseS8({}, {
      replay: async () => {
        throw new Error('The PDP answered 0 of the 100 checks it was asked');
      },
    });

    expect(result.exit.code).toBe(2);
    expect(result.exit.summary).toMatch(/^COULD NOT RUN: S8 on test stopped at step 10 \(Replay lists the changed decisions\): the replay could not run: The PDP answered 0 of the 100 checks/);
  });
});

describe('the audit trail of the S8 runner', () => {
  /** A Permit API that answers the key's scope and every audit-log page with `page`, and records what it was asked. */
  const permitApi = (page: unknown) => {
    const asked: string[] = [];
    const get = async (path: string): Promise<unknown> => {
      asked.push(path);
      return path.startsWith('/v2/api-key/scope') ? { project_id: 'proj', environment_id: 'env' } : page;
    };
    return { asked, get };
  };
  const bulkCheck = async () => [];

  it('asks for the newest decision of the user in the window, with both ends of the window, and reads nothing else', async () => {
    const api = permitApi({ data: [{ timestamp: '2026-10-07T15:53:25+00:00' }] });
    const trail = auditTrailWith({ get: api.get, bulkCheck }, () => 1_791_388_410_500);

    expect(await trail.audited('frodo', 1_791_388_405_900)).toBe(true);

    const query = new URL(api.asked[1] ?? '', 'http://permit').searchParams;
    expect(api.asked[1]).toMatch(/^\/v2\/pdps\/proj\/env\/audit_logs\?/);
    expect(Object.fromEntries(query)).toEqual({
      users: 'frodo', action: 'view_billing', timestamp_from: '1791388405', timestamp_to: '1791388412', page: '1', per_page: '1',
    });
  });

  it('is false while the log lists nothing of the user since then, and an error when the answer is not a page', async () => {
    expect(await auditTrailWith({ get: permitApi({ data: [] }).get, bulkCheck }).audited('frodo', 0)).toBe(false);
    await expect(auditTrailWith({ get: permitApi({ message: 'nope' }).get, bulkCheck }).audited('frodo', 0)).rejects.toThrow('something other than a page of decisions');
  });

  it('replays the view_billing decisions of the window the runner names', async () => {
    const api = permitApi({ data: [] });
    const trail = auditTrailWith({ get: api.get, bulkCheck });

    const report = await trail.replay({ since: 1_791_388_000_000, until: 1_791_388_100_000 });

    expect(report).toMatchObject({ total: 0, changed: [], pages: 1 });
    const query = new URL(api.asked[1] ?? '', 'http://permit').searchParams;
    expect(Object.fromEntries(query)).toMatchObject({ action: 'view_billing', timestamp_from: '1791388000', timestamp_to: '1791388100' });
  });
});
