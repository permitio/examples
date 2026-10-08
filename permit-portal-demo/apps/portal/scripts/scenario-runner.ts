// Shared by the scenario runners (scenario-s1.ts, -s2.ts, -s4.ts, -s5.ts and -s8.ts): the step helper, a JSON client for the
// portal and the Great Eagle systems mock, the decision assertions and the decision-panel feed. It is not a scenario
// itself: bin/demo scenario takes s1, s2, s4, s5 or s8.
import { describeError } from './lib/admin';
import { ARAGORN } from './lib/fixtures';
import { type CheckSpec, describeCheck, pollUntil } from './lib/pdp';
import { finish, isMain, type Outcome, type Result } from './lib/report';

export type Log = (line: string) => void;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One request's limit. A waited write may take 5 s on the PDP, and a handover or an org creation makes several. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The service answered, but not as the step expects: the rehearsal failed (exit 1). */
export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepError';
  }
}

/** The service did not answer at all (refused, unreachable or too slow): the scenario could not run (exit 2). */
export class ServiceUnreachable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ServiceUnreachable';
  }
}

/** The demo never reached the state the first step starts from: the scenario could not run (exit 2). */
export class NotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReady';
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function preview(value: unknown): string {
  if (value === undefined) return 'missing';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** The service's own error text (`{ error }`), or a short preview of what it sent instead. */
export function errorText(body: unknown): string {
  if (body === undefined) return '(no body)';
  const error = isRecord(body) ? body.error : undefined;
  return typeof error === 'string' ? error : preview(body);
}

function parsed(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface Answer { status: number; body: unknown }
export interface Send { persona?: string; body?: unknown; headers?: Record<string, string> }

/** JSON over HTTP to one service. Every portal /api call names the acting persona in `x-demo-persona`. */
export class Api {
  readonly baseUrl: string;

  constructor(readonly name: string, baseUrl: string, private readonly timeoutMs = REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Answers whatever status comes back. Only a service that does not answer throws, as ServiceUnreachable. */
  async send(method: Method, path: string, opts: Send = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.persona !== undefined) headers['x-demo-persona'] = opts.persona;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { status: res.status, body: parsed(await res.text()) };
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? `no answer within ${this.timeoutMs / 1000} s` : describeError(err);
      throw new ServiceUnreachable(`the ${this.name} at ${this.baseUrl} did not answer ${method} ${path}: ${reason}`, { cause: err });
    }
  }

  /** The body of an answer with `status`. Any other status fails the step and shows the service's own error text. */
  async expect(status: number, method: Method, path: string, opts: Send = {}): Promise<unknown> {
    const answer = await this.send(method, path, opts);
    if (answer.status !== status) {
      const as = opts.persona === undefined ? '' : ` as ${opts.persona}`;
      throw new StepError(`${method} ${path}${as} answered ${answer.status}, expected ${status}: ${errorText(answer.body)}`);
    }
    return answer.body;
  }
}

// --- Reading answers. A field of another shape fails the step: the API's contract changed. ---

export function field(value: unknown, key: string): unknown {
  if (!isRecord(value)) throw new StepError(`expected an object with "${key}", got ${preview(value)}`);
  return value[key];
}

export function textOf(value: unknown, key: string): string {
  const v = field(value, key);
  if (typeof v !== 'string') throw new StepError(`expected text in "${key}", got ${preview(v)}`);
  return v;
}

export function numberOf(value: unknown, key: string): number {
  const v = field(value, key);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new StepError(`expected a number in "${key}", got ${preview(v)}`);
  return v;
}

export function booleanOf(value: unknown, key: string): boolean {
  const v = field(value, key);
  if (typeof v !== 'boolean') throw new StepError(`expected true or false in "${key}", got ${preview(v)}`);
  return v;
}

export function listOf(value: unknown, key: string): unknown[] {
  const v = field(value, key);
  if (!Array.isArray(v)) throw new StepError(`expected a list in "${key}", got ${preview(v)}`);
  return v;
}

/** A list of texts in `key`. */
export function textsOf(value: unknown, key: string): string[] {
  return listOf(value, key).map((item) => {
    if (typeof item !== 'string') throw new StepError(`expected only text in the list "${key}", got ${preview(item)}`);
    return item;
  });
}

export function expectEqual(what: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new StepError(`${what} is ${preview(actual)}, expected ${preview(expected)}`);
}

/** The fields of a workflow request (the mock's DemoRequest) that the scenarios read. */
export interface RequestView { id: string; type: string; status: string; tenant: string; requested_for: string; reviewer?: string; reviewer_comment?: string; duration_ms?: number }

export function requestOf(value: unknown): RequestView {
  const reviewer = field(value, 'reviewer');
  const comment = field(value, 'reviewer_comment');
  const duration = field(value, 'duration_ms');
  return {
    id: textOf(value, 'id'), type: textOf(value, 'type'), status: textOf(value, 'status'), tenant: textOf(value, 'tenant'),
    requested_for: textOf(value, 'requested_for'),
    ...(typeof reviewer === 'string' ? { reviewer } : {}), ...(typeof comment === 'string' ? { reviewer_comment: comment } : {}),
    ...(typeof duration === 'number' ? { duration_ms: duration } : {}),
  };
}

/** POST /api/requests/:id/approve answers the decided request and how long the PDP took to apply what it granted. */
export function approvalOf(value: unknown): { request: RequestView; ms: number } {
  return { request: requestOf(field(value, 'request')), ms: numberOf(value, 'ms') };
}

/**
 * Fails the step unless `actual` holds exactly the items of `expected`, each as often, in any order. The message lists what
 * is missing and what is extra, so a wrong list says how it is wrong.
 */
export function expectSameItems(what: string, actual: readonly string[], expected: readonly string[]): void {
  const left = new Map<string, number>();
  for (const item of expected) left.set(item, (left.get(item) ?? 0) + 1);
  const extra: string[] = [];
  for (const item of actual) {
    const remaining = left.get(item) ?? 0;
    if (remaining > 0) left.set(item, remaining - 1);
    else extra.push(item);
  }
  const missing = [...left].flatMap(([item, count]) => Array<string>(count).fill(item));
  if (missing.length === 0 && extra.length === 0) return;
  const parts = [...(missing.length > 0 ? [`lacks ${missing.join(', ')}`] : []), ...(extra.length > 0 ? [`also has ${extra.join(', ')}`] : [])];
  throw new StepError(`${what} ${parts.join(' and ')}`);
}

export const ms = (value: number) => `${Math.round(value)} ms`;
export const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;

// --- Decisions, asked through the portal's enforcement point exactly as the UI asks them. ---

/** A check, with the decision the scenario expects. */
export interface Expected extends CheckSpec { expect: boolean }

const word = (allow: boolean) => (allow ? 'allow' : 'deny');

/** Each check's decision from the portal's POST /api/checks/bulk: one call per persona, the persona being the user. */
export async function decisionsOf(portal: Api, checks: readonly CheckSpec[]): Promise<boolean[]> {
  const allows = new Array<boolean>(checks.length).fill(false);
  for (const user of new Set(checks.map((c) => c.user))) {
    const mine = checks.flatMap((check, at) => (check.user === user ? [{ check, at }] : []));
    const items = mine.map(({ check: c }) => ({
      action: c.action, resource: { type: c.type, key: c.key, tenant: c.tenant, ...(c.extra ? { attributes: c.extra } : {}) },
    }));
    const results = listOf(await portal.expect(200, 'POST', '/api/checks/bulk', { persona: user, body: { checks: items } }), 'results');
    if (results.length !== mine.length) throw new StepError(`the portal answered ${results.length} decisions for ${mine.length} checks`);
    mine.forEach(({ at }, n) => {
      allows[at] = booleanOf(results[n], 'allow');
    });
  }
  return allows;
}

/** One line per decision, and the ones that differ from what was expected. */
function compare(expected: readonly Expected[], allows: readonly boolean[]): { lines: string[]; wrong: string[] } {
  const got = (i: number) => allows[i] === true;
  return {
    lines: expected.map((c, i) => `${word(got(i)).padEnd(5)} ${describeCheck(c)}`),
    wrong: expected.flatMap((c, i) => (got(i) === c.expect ? [] : [`${describeCheck(c)}: expected ${word(c.expect)}, got ${word(got(i))}`])),
  };
}

/** Asks for every decision once and fails the step on any that differs. Each decision becomes a note of the step. */
export async function expectDecisions(s: StepContext, portal: Api, expected: readonly Expected[]): Promise<void> {
  const { lines, wrong } = compare(expected, await decisionsOf(portal, expected));
  for (const line of lines) s.note(line);
  if (wrong.length > 0) throw new StepError(wrong.join('; '));
}

/** Asks again until every decision matches, or the deadline passes. A bounded poll, never a fixed sleep. */
export async function waitForDecisions(portal: Api, expected: readonly Expected[], opts: { timeoutMs: number; intervalMs: number }):
  Promise<{ ok: boolean; lines: string[]; wrong: string[]; elapsedMs: number }> {
  const polled = await pollUntil(async () => compare(expected, await decisionsOf(portal, expected)), (c) => c.wrong.length === 0, opts);
  return { ok: polled.ok, ...polled.value, elapsedMs: polled.elapsedMs };
}

// --- Steps ---

export interface StepContext {
  /** Adds a line under the step's PASS or FAIL line. */
  note(line: string): void;
}

/** A step that did not hold. The run stops there. */
export class StepFailed extends Error {
  constructor(readonly where: string, readonly reason: unknown) {
    super(`${where}: ${describeError(reason)}`);
    this.name = 'StepFailed';
  }
}

/** Runs the steps in order, printing PASS or FAIL for each with its notes. The first failure throws StepFailed. */
export class Steps {
  private n = 0;

  constructor(private readonly log: Log) {}

  /** How many numbered steps have started. */
  get count(): number {
    return this.n;
  }

  /** A numbered step of the scenario. */
  step<T>(name: string, fn: (s: StepContext) => Promise<T>): Promise<T> {
    this.n += 1;
    return this.run(`${this.n}. ${name}`, `step ${this.n} (${name})`, fn);
  }

  /** The starting state the scenario needs beyond the reset, before its first numbered step. */
  start<T>(name: string, fn: (s: StepContext) => Promise<T>): Promise<T> {
    return this.run(`Start: ${name}`, `the start check (${name})`, fn);
  }

  private async run<T>(label: string, where: string, fn: (s: StepContext) => Promise<T>): Promise<T> {
    const notes: string[] = [];
    const started = performance.now();
    const print = (verdict: string, lines: readonly string[]) => {
      this.log(`${verdict.padEnd(5)} ${label} (${seconds(performance.now() - started)})`);
      for (const line of lines) this.log(`        ${line}`);
    };
    try {
      const value = await fn({ note: (line) => notes.push(line) });
      print('PASS', notes);
      return value;
    } catch (err) {
      print('FAIL', [...notes, describeError(err)]);
      throw new StepFailed(where, err);
    }
  }
}

// --- The state the scenario starts from, and the decision panel's feed ---

/** The reset writes straight to Permit, so it reaches the PDP a little later: wait this long for it before step 1. */
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 500;

/**
 * The start check of a scenario that begins from a state Permit holds: waits until the PDP answers every check in
 * `expected` as the reset state says, or fails with NotReady (the scenario could not run, exit 2) when it never does.
 */
export function awaitResetState(
  run: Steps, portal: Api, expected: readonly Expected[], timing = { timeoutMs: START_TIMEOUT_MS, intervalMs: START_POLL_MS },
): Promise<void> {
  return run.start('the PDP shows the reset state', async (s) => {
    const waited = await waitForDecisions(portal, expected, timing);
    for (const line of waited.lines) s.note(line);
    if (!waited.ok) throw new NotReady(`after ${seconds(waited.elapsedMs)} the PDP still answers ${waited.wrong.join('; ')}: the reset has not reached it`);
  });
}

/** A check, as the portal's decision-panel feed (GET /api/events) lists it. `label` names the subject when it is not a persona. */
export interface FeedCheck { id: number; kind: 'check'; user: string; action: string; resource: string; allow: boolean; label?: string }
/** A write to Permit, as the feed lists it: what it did, and whether the PDP confirmed it. */
export interface FeedWrite { id: number; kind: 'write'; what: string; ok: boolean; ms: number }
export type FeedEvent = FeedCheck | FeedWrite;

/** The newest id in the feed. Asking for the events after the largest possible id returns none. */
export async function lastEventId(portal: Api): Promise<number> {
  return numberOf(await portal.expect(200, 'GET', `/api/events?since=${Number.MAX_SAFE_INTEGER}`, { persona: ARAGORN }), 'lastId');
}

/** The checks and writes the feed lists after event `since`, oldest first. */
export async function eventsSince(portal: Api, since: number): Promise<FeedEvent[]> {
  const events = listOf(await portal.expect(200, 'GET', `/api/events?since=${since}`, { persona: ARAGORN }), 'events');
  return events.flatMap((event): FeedEvent[] => {
    const id = numberOf(event, 'id');
    const kind = field(event, 'kind');
    if (kind === 'write') return [{ id, kind, what: textOf(event, 'what'), ok: booleanOf(event, 'ok'), ms: numberOf(event, 'ms') }];
    if (kind !== 'check') return [];
    const label = field(event, 'label');
    return [{
      id, kind, user: textOf(event, 'user'), action: textOf(event, 'action'), resource: textOf(event, 'resource'), allow: booleanOf(event, 'allow'),
      ...(typeof label === 'string' ? { label } : {}),
    }];
  });
}

export interface ScenarioOptions {
  /** Names the run in the summary, for example "S4 on demo". */
  title: string;
  /** The profile this run resets and checks. The running portal must use the same one. */
  profile: string;
  portal: Api;
  /** Puts the demo back in its starting state first (runReset). Anything but a pass means the scenario could not run. */
  reset: () => Promise<Outcome>;
  log: Log;
}

/** A failure to reach a service or the starting state means the scenario could not run; any other is a failed rehearsal. */
const outcomeOfStep = (reason: unknown): Outcome => (reason instanceof ServiceUnreachable || reason instanceof NotReady ? 'could-not-run' : 'fail');

/**
 * Checks that the portal runs this profile, resets the demo, then runs the steps. The first failing step stops the run:
 * exit 1 for a wrong answer, exit 2 when a service did not answer or the demo never reached its starting state.
 * "Could not run" is never reported as a pass.
 */
export async function runScenario(opts: ScenarioOptions, steps: (run: Steps) => Promise<void>): Promise<Result> {
  // One Compose stack runs at a time. A portal on another profile would mean resetting one Permit environment while
  // the portal and its PDP decide in another.
  let running: string;
  try {
    running = textOf(await opts.portal.expect(200, 'GET', '/api/meta', { persona: ARAGORN }), 'profile');
  } catch (err) {
    return { outcome: outcomeOfStep(err), summary: `${opts.title} did not start: ${describeError(err)}; is the stack up (bin/demo up ${opts.profile})?` };
  }
  if (running !== opts.profile) {
    return { outcome: 'could-not-run',
      summary: `${opts.title} did not start: the portal at ${opts.portal.baseUrl} runs profile ${running}. Run the scenario with ${running}, or switch the stack: bin/demo down ${running}, then bin/demo up ${opts.profile}` };
  }
  opts.log(`The portal at ${opts.portal.baseUrl} runs profile ${running}.`);
  opts.log('Resetting the demo first, as bin/demo reset does:');
  const reset = await opts.reset();
  opts.log('');
  if (reset !== 'pass') {
    return { outcome: 'could-not-run', summary: `${opts.title} did not start, because the reset did not pass (${reset}); see its output above and the README` };
  }
  const run = new Steps(opts.log);
  const started = performance.now();
  try {
    await steps(run);
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    return { outcome: outcomeOfStep(err.reason), summary: `${opts.title} stopped at ${err.where}: ${describeError(err.reason)}` };
  }
  return { outcome: 'pass', summary: `${opts.title}: all ${run.count} steps passed in ${seconds(performance.now() - started)}` };
}

if (isMain(import.meta.url)) finish('could-not-run', 'scenario-runner.ts holds the steps the runners share; run bin/demo scenario <profile> s1, s2, s4, s5 or s8');
