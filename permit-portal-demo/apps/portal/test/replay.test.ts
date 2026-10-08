// S8's two scripts on the portal side: the replay, which re-asks the decisions in Permit's audit log against today's
// policy and data (scripts/replay.ts), and the reset hook that undoes S8's writes (scripts/reset/s8.ts). The audit-log API
// and the PDP are doubles; what is under test is the question the replay sends, what it reports, and that a read that
// failed is never reported as "nothing changed".
import type { ICheckQuery, Permit } from 'permitio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptEnv } from '../scripts/lib/env';
import {
  AUDIT_RETRY_WAITS_MS, type AuditEntry, checkFromEntry, groupChanges, NoAnswerError, parseReplayArgs, permitGet, type ReplayDeps, replayAuditLog, runReplay, USAGE,
  UsageError,
} from '../scripts/replay';
import { resetS8 } from '../scripts/reset/s8';

const SINCE = Date.parse('2026-10-07T14:00:00.000Z');
const UNTIL = Date.parse('2026-10-07T14:30:00.000Z');
const WINDOW = { project: 'proj-1', environment: 'env-1', since: SINCE, until: UNTIL, action: 'view_billing' };
const env: ScriptEnv = {
  profile: 'staging', apiUrl: 'https://permit.invalid', apiKey: 'test-api-key', pdpUrl: 'http://pdp.invalid:7766',
  greatEagleSystemsUrl: 'http://systems.invalid', portalUrl: 'http://portal.invalid',
};

interface EntrySpec { user: string; action: string; type: string; key: string; tenant: string; decision: boolean; at: string; attributes: Record<string, unknown> }

/** One audit-log entry as the API lists it: the decision, and the request as the PDP evaluated it in `input`. */
function entry(over: Partial<EntrySpec> = {}): AuditEntry {
  const o: EntrySpec = {
    user: 'frodo', action: 'view_billing', type: 'account', key: 'CA-1001-A', tenant: 'shire-freight', decision: true,
    at: '2026-10-07T14:05:00.000Z', attributes: {}, ...over,
  };
  return {
    id: `${o.user}-${o.key}-${o.at}`, timestamp: o.at, user_key: o.user, action: o.action, resource_type: o.type, tenant: o.tenant, decision: o.decision,
    input: {
      user: { key: o.user, attributes: { current_time: Date.parse(o.at) } },
      action: o.action,
      resource: { type: o.type, key: o.key, tenant: o.tenant, attributes: { ...o.attributes, id: o.key } },
      context: {},
    },
  };
}

/** `n` unremarkable decisions: Sam is allowed to view billing, and still is. */
const unremarkable = (n: number): AuditEntry[] => Array.from({ length: n }, (_, i) => entry({ user: 'sam', key: `CA-1001-${i}`, at: new Date(SINCE + 60_000 + i * 1000).toISOString() }));

/** The audit-log API and the PDP, as the replay meets them. `pages` are the audit log's pages, or the error a page answers with. */
function doubles(pages: Array<AuditEntry[] | Error>, rule: (check: ICheckQuery) => boolean = () => true) {
  const requested: string[] = [];
  const batches: ICheckQuery[][] = [];
  const lines: string[] = [];
  /** Every wait the replay asked for between two attempts at a page. Nothing sleeps: the wait returns at once. */
  const waits: number[] = [];
  const deps: ReplayDeps = {
    async get(path) {
      requested.push(path);
      if (path === '/v2/api-key/scope') return { organization_id: 'org-1', project_id: 'proj-1', environment_id: 'env-1' };
      const page = Number(new URL(path, 'https://permit.invalid').searchParams.get('page'));
      const answer = pages[page - 1];
      if (answer instanceof Error) throw answer;
      return { data: answer ?? [], total_count: 0, pagination_count: 0 };
    },
    async bulkCheck(checks) {
      batches.push(checks);
      return checks.map(rule);
    },
    now: () => UNTIL,
    log: (line) => lines.push(line),
    wait: async (ms) => {
      waits.push(ms);
    },
  };
  return { deps, requested, batches, lines, waits, text: () => lines.join('\n'), auditPaths: () => requested.filter((p) => p.includes('audit_logs')) };
}

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
const userOf = (c: ICheckQuery) => (typeof c.user === 'string' ? c.user : c.user.key);
const resourceKey = (c: ICheckQuery) => (typeof c.resource === 'string' ? c.resource : c.resource.key);

describe('rebuilding a check', () => {
  it("rebuilds a check from an audit entry's input", () => {
    const at = '2026-10-07T14:05:00.000Z';
    expect(checkFromEntry(entry({ user: 'frodo', action: 'view_billing', type: 'account', key: 'CA-1001-A', at }))).toEqual({
      user: { key: 'frodo', attributes: { current_time: Date.parse(at) } },
      action: 'view_billing',
      resource: { type: 'account', key: 'CA-1001-A', tenant: 'shire-freight', attributes: { id: 'CA-1001-A' } },
    });
  });

  it('keeps the attributes and the resource key the request carried, which the CLI replay drops', () => {
    const check = checkFromEntry(entry({ type: 'shipment', key: 'SHP-77001', attributes: { requested_days: 7 } }));
    expect(check).toMatchObject({ resource: { key: 'SHP-77001', attributes: { id: 'SHP-77001', requested_days: 7 } } });
    expect(check).toMatchObject({ user: { attributes: { current_time: Date.parse('2026-10-07T14:05:00.000Z') } } });
  });

  it('accepts a user the PDP logged as the key alone, which the audit pipeline reads too', () => {
    const good = entry({ user: 'frodo' });
    const input = good.input as Record<string, unknown>;
    expect(checkFromEntry({ ...good, input: { ...input, user: 'frodo' } })).toMatchObject({ user: { key: 'frodo' }, action: 'view_billing' });
    expect(checkFromEntry({ ...good, input: { ...input, user: '' } })).toBeUndefined();
  });

  it('answers undefined for an entry whose input cannot be asked again', () => {
    const good = entry();
    const input = good.input as { user: unknown; action: unknown; resource: unknown };
    const without = (field: 'user' | 'action' | 'resource') => ({ ...good, input: { ...input, [field]: undefined } });
    expect(checkFromEntry(without('user'))).toBeUndefined();
    expect(checkFromEntry(without('action'))).toBeUndefined();
    expect(checkFromEntry(without('resource'))).toBeUndefined();
    expect(checkFromEntry({ ...good, input: { ...input, user: { attributes: {} } } })).toBeUndefined(); // no user key
    expect(checkFromEntry({ ...good, input: { ...input, resource: { key: 'CA-1001-A' } } })).toBeUndefined(); // no resource type
    expect(checkFromEntry({ ...good, input: undefined })).toBeUndefined();
    expect(checkFromEntry({ ...good, input: 'not an object' })).toBeUndefined();
  });
});

describe('reading the arguments', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1d', 86_400_000],
    ['45s', 45_000],
  ])('reads --since %s as that long before now', (value, ms) => {
    expect(parseReplayArgs(['--since', value], UNTIL)).toEqual({ since: UNTIL - ms });
  });

  it('reads --since as an ISO time, and --action', () => {
    expect(parseReplayArgs(['--since', '2026-10-07T14:00:00Z', '--action', 'view_billing'], UNTIL)).toEqual({ since: SINCE, action: 'view_billing' });
  });

  it('reads --details, which asks for every changed decision rather than the groups', () => {
    expect(parseReplayArgs(['--since', '30m', '--details'], UNTIL)).toEqual({ since: UNTIL - 30 * 60_000, details: true });
    expect(USAGE).toContain('[--details]');
  });

  it.each([
    ['nothing', []],
    ['no --since', ['--action', 'view_billing']],
    ['an empty --since', ['--since', '']],
    ['a --since that is neither', ['--since', 'yesterday']],
    ['a --since that looks like an ISO date and is not one', ['--since', '2026-13-45']],
    ['a relative --since of zero', ['--since', '0m']],
    ['a relative --since with no number', ['--since', 'm']],
    ['an empty --action', ['--since', '30m', '--action', '']],
    ['an unknown flag', ['--since', '30m', '--user', 'frodo']],
    ['a stray argument', ['--since', '30m', 'staging']],
  ])('refuses %s', (_name, argv) => {
    expect(() => parseReplayArgs(argv, UNTIL)).toThrow(UsageError);
  });
});

describe('replaying the audit log', () => {
  it('reports only the decisions that changed', async () => {
    // Page one is full (the API gives at most 100 a page); page two holds the last three, two of which changed.
    const changedAllow = entry({ user: 'frodo', key: 'CA-1001-A', decision: true, at: '2026-10-07T14:20:00.000Z' });
    const changedDeny = entry({ user: 'pippin', key: 'CA-1001-A', decision: false, at: '2026-10-07T14:21:00.000Z' });
    const same = entry({ user: 'sam', key: 'CA-1001-B', decision: true, at: '2026-10-07T14:22:00.000Z' });
    // Today: Frodo's role is gone, Pippin has one, and Sam still has what Sam had.
    const today = (c: ICheckQuery) => userOf(c) !== 'frodo';
    const { deps, batches, auditPaths } = doubles([unremarkable(100), [changedAllow, changedDeny, same]], today);

    const report = await replayAuditLog(deps, WINDOW);

    expect(report).toEqual({
      total: 103, unchanged: 101, unreplayable: 0, pages: 2,
      changed: [
        { at: '2026-10-07T14:20:00.000Z', user: 'frodo', action: 'view_billing', resource: 'account:CA-1001-A', then: true, now: false },
        { at: '2026-10-07T14:21:00.000Z', user: 'pippin', action: 'view_billing', resource: 'account:CA-1001-A', then: false, now: true },
      ],
    });
    // One bulk check per page, and each asked exactly what the page recorded.
    expect(batches.map((b) => b.length)).toEqual([100, 3]);
    expect(batches[1]?.map((c) => `${userOf(c)} ${resourceKey(c)}`)).toEqual(['frodo CA-1001-A', 'pippin CA-1001-A', 'sam CA-1001-B']);
    expect(auditPaths()).toHaveLength(2);
  });

  it('asks the audit log for the window, with both ends, the action and the page', async () => {
    const { deps, auditPaths } = doubles([[entry()]]);
    await replayAuditLog(deps, WINDOW);
    const [path] = auditPaths();
    const url = new URL(path ?? '', 'https://permit.invalid');
    expect(url.pathname).toBe('/v2/pdps/proj-1/env-1/audit_logs');
    // Both ends: the audit-log search applies the time range only when it gets timestamp_from and timestamp_to.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      timestamp_from: String(SINCE / 1000), timestamp_to: String(UNTIL / 1000), action: 'view_billing', page: '1', per_page: '100',
    });
  });

  it('sends no action filter when none was asked for', async () => {
    const { deps, auditPaths } = doubles([[entry()]]);
    await replayAuditLog(deps, { ...WINDOW, action: undefined });
    expect(new URL(auditPaths()[0] ?? '', 'https://permit.invalid').searchParams.has('action')).toBe(false);
  });

  it('lists nothing for a window in which every decision still stands', async () => {
    const { deps } = doubles([unremarkable(5)]);
    expect(await replayAuditLog(deps, WINDOW)).toEqual({ total: 5, unchanged: 5, changed: [], unreplayable: 0, pages: 1 });
  });

  it('stops at a page that is not full, and reads no further', async () => {
    const { deps, auditPaths } = doubles([unremarkable(99), unremarkable(1)]);
    const report = await replayAuditLog(deps, WINDOW);
    expect(report.pages).toBe(1);
    expect(auditPaths()).toHaveLength(1);
  });

  it('counts an entry it cannot replay apart, and never as unchanged', async () => {
    const noDecision = { ...entry({ user: 'lobelia' }), decision: undefined };
    const noInput = { ...entry({ user: 'fatty' }), input: undefined };
    const { deps, batches } = doubles([[entry(), noDecision, noInput]]);
    const report = await replayAuditLog(deps, WINDOW);
    expect(report).toMatchObject({ total: 3, unchanged: 1, unreplayable: 2, changed: [] });
    // Only what could be compared was asked.
    expect(batches.flat().map(userOf)).toEqual(['frodo']);
  });

  it('drops what the audit log returns outside the window or the action, and does not read on past it', async () => {
    // A search that ignored the time range would return everything, newest first: the replay keeps only the window.
    const inside = entry({ at: '2026-10-07T14:10:00.000Z' });
    const before = Array.from({ length: 100 }, () => entry({ at: '2026-10-07T13:00:00.000Z' }));
    const otherAction = entry({ action: 'view', at: '2026-10-07T14:11:00.000Z' });
    const afterEnd = entry({ at: '2026-10-07T15:00:00.000Z' });
    const { deps, auditPaths, batches } = doubles([[afterEnd, otherAction, inside, ...before.slice(0, 97)], before]);
    const report = await replayAuditLog(deps, WINDOW);
    expect(report).toMatchObject({ total: 1, unchanged: 1, changed: [], pages: 1 });
    expect(batches.flat()).toHaveLength(1);
    // The first page ended in entries older than the window: the log is newest first, so nothing after them is inside.
    expect(auditPaths()).toHaveLength(1);
  });

  it('fails, rather than report, when a page cannot be read after the last attempt', async () => {
    const { deps, batches, auditPaths, waits } = doubles([unremarkable(100), Object.assign(new Error('GET answered 500'), { status: 500 })]);
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow('GET answered 500');
    expect(batches).toHaveLength(1);
    // Page 2 was asked three times in all, with a short wait before each new attempt.
    expect(auditPaths().filter((p) => p.includes('page=2'))).toHaveLength(3);
    expect(waits).toEqual([...AUDIT_RETRY_WAITS_MS]);
  });

  // Staging's audit-log API answered HTTP 500 to 2 of 11 reads in one probe: a read that fails for a moment is asked again,
  // a bounded number of times, and the wait is injected, so nothing here sleeps.
  it('asks a page again after a 5xx or no answer, up to three attempts, and then reports the whole window', async () => {
    const { deps, waits, text } = doubles([]);
    const failures: unknown[] = [Object.assign(new Error('GET /v2/pdps/proj-1/env-1/audit_logs answered 503: busy'), { status: 503 }), new NoAnswerError('The Permit API did not answer')];
    deps.get = async (path) => {
      if (path === '/v2/api-key/scope') return { project_id: 'proj-1', environment_id: 'env-1' };
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return { data: unremarkable(3) };
    };
    const report = await replayAuditLog(deps, WINDOW);
    expect(report).toMatchObject({ total: 3, unchanged: 3, pages: 1 });
    expect(waits).toEqual([...AUDIT_RETRY_WAITS_MS]);
    // Three attempts in all: two failures used up, then the page.
    expect(AUDIT_RETRY_WAITS_MS).toHaveLength(2);
    expect(failures).toEqual([]);
    // Each new attempt is said, so a slower run is explained.
    expect(text()).toContain('page 1 of the audit log: the API answered 503. Asking again in 0.5 s (attempt 2 of 3)');
    expect(text()).toContain('page 1 of the audit log: the API did not answer. Asking again in 1.5 s (attempt 3 of 3)');
  });

  it('never asks again for an answer that will not change: a 4xx, or a success that is not a page', async () => {
    for (const failure of [Object.assign(new Error('GET answered 401'), { status: 401 }), Object.assign(new Error('GET answered 404'), { status: 404 })]) {
      const { deps, waits, auditPaths } = doubles([failure]);
      await expect(replayAuditLog(deps, WINDOW)).rejects.toBe(failure);
      expect(auditPaths()).toHaveLength(1);
      expect(waits).toEqual([]);
    }
    const { deps, waits } = doubles([]);
    deps.get = async () => ({ data: 'nope' });
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow(/audit/i);
    expect(waits).toEqual([]);
  });

  it('fails when the audit log answers something other than a page of decisions', async () => {
    const { deps } = doubles([]);
    deps.get = async () => ({ data: 'nope' });
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow(/audit/i);
    deps.get = async () => 'not even an object';
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow(/audit/i);
  });

  it('fails when the PDP answers a different number of decisions than it was asked', async () => {
    const { deps } = doubles([unremarkable(3)]);
    deps.bulkCheck = async () => [true];
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow('The PDP answered 1 of the 3 checks it was asked');
    // Too many is as wrong as too few: the answers cannot be lined up with the decisions.
    deps.bulkCheck = async () => [true, true, true, true];
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow('The PDP answered 4 of the 3 checks it was asked');
  });

  it('fails when the PDP answers something that is not allow or deny', async () => {
    const { deps } = doubles([unremarkable(2)]);
    deps.bulkCheck = async (checks) => checks.map(() => 'yes' as unknown as boolean);
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow('something other than allow or deny');
  });

  it('fails when the window holds more decisions than the audit log will list', async () => {
    // The API lists at most 10,000 decisions of a search: 100 full pages of 100.
    const full = unremarkable(100);
    const { deps } = doubles(Array.from({ length: 100 }, () => full));
    await expect(replayAuditLog(deps, WINDOW)).rejects.toThrow(/10,000/);
  });
});

describe('grouping the changes', () => {
  const change = (user: string, resource: string, at: string, then = true) => ({ at, user, action: 'view_billing', resource, then, now: !then });

  it('counts each user, action, resource and change once, with the earliest and latest time it knows', () => {
    expect(groupChanges([
      change('frodo', 'account:CA-1001-A', 'unknown time'),
      change('frodo', 'account:CA-1001-A', '2026-10-07T14:12:00.000Z'),
      change('frodo', 'account:CA-1001-A', '2026-10-07T14:10:00.000Z'),
      change('pippin', 'account:CA-1001-A', '2026-10-07T14:20:00.000Z', false),
      change('pippin', 'account:CA-1001-A', '2026-10-07T14:21:00.000Z', false),
      change('frodo', 'account:CA-1001-A', '2026-10-07T14:13:00.000Z', false),
    ])).toEqual([
      { user: 'frodo', action: 'view_billing', resource: 'account:CA-1001-A', then: true, now: false, count: 3, first: '2026-10-07T14:10:00.000Z', last: '2026-10-07T14:12:00.000Z' },
      { user: 'pippin', action: 'view_billing', resource: 'account:CA-1001-A', then: false, now: true, count: 2, first: '2026-10-07T14:20:00.000Z', last: '2026-10-07T14:21:00.000Z' },
      // The same user and resource the other way round is a change of its own.
      { user: 'frodo', action: 'view_billing', resource: 'account:CA-1001-A', then: false, now: true, count: 1, first: '2026-10-07T14:13:00.000Z', last: '2026-10-07T14:13:00.000Z' },
    ]);
  });

  it('keeps "unknown time" when no change of the group has a time it can read', () => {
    expect(groupChanges([change('frodo', 'account:CA-1001-A', 'unknown time')])).toEqual([
      expect.objectContaining({ count: 1, first: 'unknown time', last: 'unknown time' }),
    ]);
  });
});

describe('running the replay', () => {
  it('prints the totals and each change that would happen, and exits 0', async () => {
    const changed = entry({ user: 'frodo', key: 'CA-1001-A', decision: true, at: '2026-10-07T14:20:00.000Z' });
    const { deps, text, requested } = doubles([[...unremarkable(4), changed]], (c) => userOf(c) !== 'frodo');
    const result = await runReplay(env, ['--since', '30m', '--action', 'view_billing'], deps);
    expect(result.outcome).toBe('pass');
    expect(result.summary).toContain('5 decisions');
    expect(result.summary).toContain('1 would change');
    // The scope comes from the key, not from a setting.
    expect(requested[0]).toBe('/v2/api-key/scope');
    expect(requested[1]).toContain('/v2/pdps/proj-1/env-1/audit_logs?');
    const out = text();
    expect(out).toMatch(/total\s+5\b/i);
    expect(out).toMatch(/unchanged\s+4\b/i);
    expect(out).toMatch(/would change\s+1\b/i);
    // The change, with who, what, on what, when, then and now; and nothing about the four that stand.
    const line = out.split('\n').find((l) => l.includes('frodo'));
    expect(line).toBeDefined();
    for (const part of ['2026-10-07T14:20:00.000Z', 'view_billing', 'account:CA-1001-A', 'ALLOW', 'DENY']) expect(line, part).toContain(part);
    expect(line?.indexOf('ALLOW')).toBeLessThan(line?.indexOf('DENY') ?? -1);
    expect(out).not.toMatch(/\bsam\b/);
    // Never the key.
    expect(out).not.toContain('test-api-key');
  });

  // On staging one window held 421 changed decisions: one line each was 432 lines, too long to read on camera. By default the
  // replay prints one line per user, action, resource and change, with how many and the first and last time.
  it('groups the changed decisions by default, most frequent first, and lists each one only with --details', async () => {
    const at = (minute: number) => `2026-10-07T14:${String(minute).padStart(2, '0')}:00.000Z`;
    const frodoA = [12, 10, 14, 11, 13].map((m) => entry({ user: 'frodo', key: 'CA-1001-A', decision: true, at: at(m) }));
    const pippin = [20, 21].map((m) => entry({ user: 'pippin', key: 'CA-1001-A', decision: false, at: at(m) }));
    const frodoB = [entry({ user: 'frodo', key: 'CA-1001-B', decision: true, at: at(15) })];
    const today = (c: ICheckQuery) => userOf(c) !== 'frodo';

    const grouped = doubles([[...frodoA, ...pippin, ...frodoB, ...unremarkable(2)]], today);
    expect((await runReplay(env, ['--since', '30m'], grouped.deps)).outcome).toBe('pass');
    const rows = grouped.lines.filter((l) => /\b(frodo|pippin)\b/.test(l));
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows;
    // Frodo on Hobbiton, five times, from 14:10 to 14:14: the earliest and the latest of the five, whatever order they came in.
    expect(first).toMatch(/^\s+5\s+frodo\s+view_billing\s+account:CA-1001-A\s+then ALLOW, now DENY\s+2026-10-07T14:10:00\.000Z\s+2026-10-07T14:14:00\.000Z$/);
    expect(second).toMatch(/^\s+2\s+pippin\s+view_billing\s+account:CA-1001-A\s+then DENY, now ALLOW\s+2026-10-07T14:20:00\.000Z\s+2026-10-07T14:21:00\.000Z$/);
    expect(third).toMatch(/^\s+1\s+frodo\s+view_billing\s+account:CA-1001-B\s+then ALLOW, now DENY\s+2026-10-07T14:15:00\.000Z\s+2026-10-07T14:15:00\.000Z$/);
    expect(grouped.text()).toContain('--details');
    // A time in the middle of a group is not printed on its own.
    expect(grouped.text()).not.toContain(at(12));
    // The totals block is the same either way.
    expect(grouped.text()).toMatch(/would change\s+8\b/i);

    const detailed = doubles([[...frodoA, ...pippin, ...frodoB, ...unremarkable(2)]], today);
    expect((await runReplay(env, ['--since', '30m', '--details'], detailed.deps)).outcome).toBe('pass');
    expect(detailed.lines.filter((l) => /\b(frodo|pippin)\b/.test(l))).toHaveLength(8);
    expect(detailed.text()).toContain(at(12));
    expect(detailed.text()).toMatch(/would change\s+8\b/i);
  });

  it('exit 2 after the last attempt at a page that keeps failing, with no report', async () => {
    const { deps, text, waits } = doubles([Object.assign(new Error('GET /v2/pdps/proj-1/env-1/audit_logs answered 500: Internal Server Error'), { status: 500 })]);
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toContain('answered 500');
    expect(waits).toEqual([...AUDIT_RETRY_WAITS_MS]);
    expect(text()).not.toMatch(/total|unchanged|would change/i);
  });

  it('says so when no decision would change', async () => {
    const { deps, text } = doubles([unremarkable(3)]);
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('pass');
    expect(text()).toMatch(/no decision would change/i);
  });

  it('reports an empty window as empty, never as unchanged', async () => {
    const { deps, text } = doubles([[]]);
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('pass');
    expect(text()).toMatch(/no decisions/i);
    expect(text()).not.toMatch(/unchanged/i);
    expect(text()).not.toMatch(/no decision would change/i);
  });

  it('exit 2 when none of the decisions it read can be compared, rather than say that nothing changed', async () => {
    // Entries it cannot ask again (no input, no recorded decision) prove nothing: if every one is like that, the format may have changed.
    const noInput = { ...entry({ user: 'fatty' }), input: undefined };
    const noDecision = { ...entry({ user: 'lobelia' }), decision: undefined };
    const { deps, text, batches } = doubles([[noInput, noDecision]]);
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toMatch(/2 decisions/);
    expect(result.summary).toMatch(/none of them/i);
    expect(text()).not.toMatch(/no decision would change|unchanged/i);
    expect(batches).toEqual([]);
  });

  it('still passes when only some of the decisions it read cannot be compared, and counts them', async () => {
    const noInput = { ...entry({ user: 'fatty' }), input: undefined };
    const { deps, text } = doubles([[entry(), noInput]]);
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('pass');
    expect(text()).toMatch(/not replayable\s+1\b/i);
  });

  it('exit 2 when the audit API is unreachable', async () => {
    const { deps, text } = doubles([]);
    deps.get = async () => {
      throw refused();
    };
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toContain('ECONNREFUSED');
    // Nothing was read, so nothing is claimed: not a total, not "unchanged", not "no decision would change".
    expect(text()).not.toMatch(/total|unchanged|would change/i);
  });

  it('exit 2 when a page fails halfway, without a report', async () => {
    const { deps, text } = doubles([unremarkable(100), Object.assign(new Error('Permit API answered 503'), { status: 503 })]);
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toContain('503');
    expect(text()).not.toMatch(/total|unchanged|would change/i);
  });

  it('exit 2 when the PDP cannot be asked', async () => {
    const { deps } = doubles([unremarkable(2)]);
    deps.bulkCheck = async () => {
      throw refused();
    };
    expect((await runReplay(env, ['--since', '30m'], deps)).outcome).toBe('could-not-run');
  });

  it('exit 2 when the key has no project or environment scope', async () => {
    const { deps } = doubles([[entry()]]);
    deps.get = async (path) => (path === '/v2/api-key/scope' ? { organization_id: 'org-1' } : { data: [] });
    const result = await runReplay(env, ['--since', '30m'], deps);
    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toMatch(/environment/i);
  });

  it('exit 2 with the usage for arguments it cannot use, before it asks anything', async () => {
    const { deps, requested } = doubles([[entry()]]);
    const result = await runReplay(env, ['--since', 'yesterday'], deps);
    expect(result.outcome).toBe('could-not-run');
    expect(result.summary).toContain(USAGE);
    expect(requested).toEqual([]);
  });
});

describe('reading the Permit API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the profile key and answers the JSON the API sent', async () => {
    const fetched = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ project_id: 'proj-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    // A trailing slash on the API URL does not double up in the request.
    const body = await permitGet({ ...env, apiUrl: 'https://permit.invalid/' })('/v2/api-key/scope');
    expect(body).toEqual({ project_id: 'proj-1' });
    const [url, init] = fetched.mock.calls[0] ?? [];
    expect(url).toBe('https://permit.invalid/v2/api-key/scope');
    expect(init?.headers).toEqual({ authorization: 'Bearer test-api-key' });
  });

  it('names where and why when the API cannot be reached, though Node says only "fetch failed"', async () => {
    // Node's fetch keeps the reason in `cause`, which can be an AggregateError, one error per address tried, with no message of its own.
    const cause = new AggregateError([Object.assign(new Error(''), { code: 'ECONNREFUSED' })], '');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed', { cause });
    });
    const failure = await permitGet(env)('/v2/pdps/proj-1/env-1/audit_logs?page=1').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('https://permit.invalid');
    expect(message).toContain('/v2/pdps/proj-1/env-1/audit_logs');
    expect(message).toContain('ECONNREFUSED');
    // The query is not echoed, and the key never is.
    expect(message).not.toContain('page=1');
    expect(message).not.toContain('test-api-key');
  });

  it('says so when the API takes too long', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    await expect(permitGet(env)('/v2/api-key/scope')).rejects.toThrow(/no answer within \d+ s/);
  });

  it("throws the status, and the API's own words, for an answer that is not a success", async () => {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"Invalid API key"}', { status: 401 }));
    const failure = await permitGet(env)('/v2/api-key/scope?x=1').catch((e: unknown) => e);
    expect((failure as { status?: number }).status).toBe(401);
    expect((failure as Error).message).toContain('401');
    expect((failure as Error).message).toContain('/v2/api-key/scope');
    expect((failure as Error).message).toContain('Invalid API key');
    expect((failure as Error).message).not.toContain('x=1');
  });

  it('throws for a success that is not JSON, rather than read it as an empty page', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>maintenance</html>', { status: 200 }));
    await expect(permitGet(env)('/v2/api-key/scope')).rejects.toThrow('did not answer JSON');
  });
});

describe('resetting S8', () => {
  type Held = { user: string; role: string; tenant: string; resource_instance?: string };
  const PIPPIN: Held = { user: 'pippin', role: 'account_manager', tenant: 'shire-freight', resource_instance: 'account:CA-1001-A' };
  const FRODO: Held = { user: 'frodo', role: 'account_admin', tenant: 'shire-freight', resource_instance: 'ean:EAN-1001' };
  const status = (code: number) => Object.assign(new Error(`Request failed with status code ${code}`), { status: code });

  /** Permit's role assignments, as the reset reads and writes them. */
  function fakePermit(held: Held[]) {
    const writes: string[] = [];
    const same = (a: Held, b: Held) => a.user === b.user && a.role === b.role && a.tenant === b.tenant && a.resource_instance === b.resource_instance;
    const faults: { unassign?: Error; assign?: Error } = {};
    const users = {
      unassignRole: vi.fn(async (a: Held) => {
        writes.push(`unassign ${a.role} ${a.resource_instance ?? a.tenant} ${a.user}`);
        if (faults.unassign) throw faults.unassign;
        const at = held.findIndex((h) => same(h, a));
        if (at < 0) throw status(404);
        held.splice(at, 1);
      }),
      assignRole: vi.fn(async (a: Held) => {
        writes.push(`assign ${a.role} ${a.resource_instance ?? a.tenant} ${a.user}`);
        if (faults.assign) throw faults.assign;
        if (held.some((h) => same(h, a))) throw status(409);
        held.push(a);
      }),
    };
    const roleAssignments = {
      list: vi.fn(async (p: { user?: string; role?: string; tenant?: string }) =>
        held.filter((h) => (!p.user || h.user === p.user) && (!p.role || h.role === p.role) && (!p.tenant || h.tenant === p.tenant)).map((h) => ({ ...h }))),
    };
    return { permit: { api: { users, roleAssignments } } as unknown as Permit, held, writes, faults, users };
  }

  it("takes the mapping's role away from Pippin and gives Frodo's EAN-1001 admin role back", async () => {
    const f = fakePermit([{ ...PIPPIN }]);
    const log: string[] = [];
    await resetS8(f.permit, (line) => log.push(line));
    expect(f.writes).toEqual(['unassign account_manager account:CA-1001-A pippin', 'assign account_admin ean:EAN-1001 frodo']);
    expect(f.users.unassignRole).toHaveBeenCalledWith({ user: 'pippin', role: 'account_manager', tenant: 'shire-freight', resource_instance: 'account:CA-1001-A' });
    expect(f.users.assignRole).toHaveBeenCalledWith({ user: 'frodo', role: 'account_admin', tenant: 'shire-freight', resource_instance: 'ean:EAN-1001' });
    expect(f.held).toEqual([FRODO]);
    expect(log.join('\n')).toMatch(/removed/);
    expect(log.join('\n')).toMatch(/created/);
  });

  it('writes nothing when S8 left nothing to undo', async () => {
    const f = fakePermit([{ ...FRODO }]);
    const log: string[] = [];
    await resetS8(f.permit, (line) => log.push(line));
    expect(f.writes).toEqual([]);
    expect(f.held).toEqual([FRODO]);
    expect(log.join('\n')).toMatch(/absent/);
    expect(log.join('\n')).toMatch(/exists/);
  });

  it('leaves every other assignment alone', async () => {
    const others: Held[] = [
      { user: 'pippin', role: 'developer', tenant: 'shire-freight' },
      { user: 'pippin', role: 'account_manager', tenant: 'shire-freight', resource_instance: 'account:CA-1001-B' },
      { user: 'frodo', role: 'org_member', tenant: 'shire-freight' },
      { user: 'sam', role: 'org_admin', tenant: 'shire-freight' },
    ];
    const f = fakePermit([...others.map((o) => ({ ...o })), { ...PIPPIN }]);
    await resetS8(f.permit, () => undefined);
    expect(f.held).toEqual([...others, FRODO]);
  });

  it("does not touch Pippin's role on another account", async () => {
    const elsewhere: Held = { user: 'pippin', role: 'account_manager', tenant: 'shire-freight', resource_instance: 'account:CA-1001-B' };
    const f = fakePermit([{ ...elsewhere }, { ...FRODO }]);
    await resetS8(f.permit, () => undefined);
    expect(f.writes).toEqual([]);
    expect(f.held).toEqual([elsewhere, FRODO]);
  });

  it('treats an unassign that answers 404 and an assign that answers 409 as already done', async () => {
    const f = fakePermit([{ ...PIPPIN }]);
    f.faults.unassign = status(404);
    f.faults.assign = status(409);
    await expect(resetS8(f.permit, () => undefined)).resolves.toBeUndefined();
  });

  it('stops at any other error from Permit, before it writes anything more', async () => {
    const f = fakePermit([{ ...PIPPIN }]);
    f.faults.unassign = status(500);
    await expect(resetS8(f.permit, () => undefined)).rejects.toThrow(/500/);
    expect(f.users.assignRole).not.toHaveBeenCalled();
  });
});
