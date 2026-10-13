// Re-asks the decisions Permit's audit log recorded against today's policy and data, and lists the
// ones that would change, grouped by user, action, resource and change; --details lists each
// decision instead.
// Run: bin/demo replay <profile> --since <ISO time, or 30m, 2h, 1d> [--action view_billing]
// [--details] Exit 0 with the report, 2 when it could not run. A read that failed is never an empty
// one, so it is never reported as "nothing changed". The replayed checks are real checks: they
// appear in the Audit Log too, from the moment the run starts.
import { parseArgs } from 'node:util';
import type { ICheckQuery, IResource, IUser } from 'permitio';
import { describeError, HttpError, scriptPermit, statusOf } from '#scripts/lib/admin';
import { type ScriptEnv, scriptEnv } from '#scripts/lib/env';
import { isMain, type Result, runCli } from '#scripts/lib/report';

export const USAGE =
  'usage: bin/demo replay <profile> --since <ISO time, or 30m, 2h, 1d> [--action <action>] [--details]';

/** The audit-log API lists at most 100 decisions a page, and at most 10,000 of one search. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
/** One request's limit: the audit log is searched in OpenSearch, which can be slow on a wide window. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long to wait before asking for a page of the audit log again, after its first and its second
 * failed attempt: three attempts in all. Only a failure that may pass is asked again, a 5xx or no
 * answer at all (staging's audit-log API answered 500 to 2 of 11 reads in one probe); a 4xx, or an
 * answer that is not a page, would only fail the same way.
 */
export const AUDIT_RETRY_WAITS_MS = [500, 1_500] as const;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The arguments are not usable, so the script could not run. */
export class UsageError extends Error {}

/**
 * The Permit API gave no answer at all: refused, unreachable or too slow. Like a 5xx, it may pass,
 * so a page is asked again.
 */
export class NoAnswerError extends Error {}

export interface ReplayArgs {
  since: number;
  action?: string;
  details?: true;
}

/**
 * One entry of the audit-log API's page (`data`): what the replay reads of it, and the request as
 * the PDP evaluated it in `input`.
 */
export interface AuditEntry {
  id?: string;
  timestamp?: string;
  user_key?: string;
  action?: string;
  resource_type?: string;
  tenant?: string;
  decision?: boolean | null | undefined;
  input?: unknown;
}

/** One recorded decision that today's policy and data would answer differently. */
export interface DecisionChange {
  at: string;
  user: string;
  action: string;
  resource: string;
  was: boolean;
  now: boolean;
}

export interface ReplayReport {
  /** Decisions the audit log holds in the window. */
  total: number;
  /** Replayed, and answered as before. */
  unchanged: number;
  changed: DecisionChange[];
  /** Entries with no usable input or no recorded decision, so there was nothing to compare. */
  unreplayable: number;
  /** Pages of the audit log that were read. */
  pages: number;
}

/**
 * What the replay needs from the outside: the Permit API's JSON, the local PDP's bulk check, the
 * clock, the output, and the wait between two attempts at a page of the audit log.
 */
export interface ReplayDeps {
  get(path: string): Promise<unknown>;
  bulkCheck(checks: ICheckQuery[]): Promise<boolean[]>;
  now(): number;
  log(line: string): void;
  wait(ms: number): Promise<void>;
}

/**
 * What replaying the audit log takes: reads and checks, and, when the caller has them, its own wait
 * and output.
 */
type AuditReader = Pick<ReplayDeps, 'get' | 'bulkCheck'> &
  Partial<Pick<ReplayDeps, 'wait' | 'log'>>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReplayWindow {
  project: string;
  environment: string;
  since: number;
  until: number;
  action?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** `--since` as a time in ms: an ISO date or time, or a length of time before `now`. */
function sinceOf(value: string, now: number): number {
  const length = /^(?<count>\d+)(?<unit>[smhd])$/.exec(value)?.groups;
  if (length !== undefined) {
    const ms = Number(length['count']) * (UNIT_MS[length['unit'] ?? ''] ?? 0);
    if (ms > 0) return now - ms;
  } else if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}.*)?$/.test(value)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return time;
  }
  throw new UsageError(
    `--since must be an ISO time such as 2026-10-07T14:00:00Z, or a length of time such as 30m, 2h or 1d, not "${value}"`,
  );
}

/**
 * The arguments after the profile: `--since` (required) and `--action`. Anything else is a
 * UsageError.
 */
export function parseReplayArgs(argv: string[], now: number): ReplayArgs {
  let values: { since?: string; action?: string; details?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        since: { type: 'string' },
        action: { type: 'string' },
        details: { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (values.since === undefined) throw new UsageError('--since is required');
  if (values.action === '') throw new UsageError('--action must not be empty');
  return {
    since: sinceOf(values.since, now),
    ...(values.action === undefined ? {} : { action: values.action }),
    ...(values.details === true ? { details: true } : {}),
  };
}

/** A check the replay asks: always a user and a resource as objects, whatever an ICheckQuery allows. */
export interface ReplayCheck extends ICheckQuery {
  user: IUser;
  resource: IResource;
}

/**
 * The check an audit entry records, asked again: the user, the action and the resource as the PDP
 * evaluated them, with their attributes and the resource's key, which the CLI replay drops.
 * Undefined when the entry does not hold enough to ask.
 */
export function checkFromEntry(entry: AuditEntry): ReplayCheck | undefined {
  const { input } = entry;
  if (!isRecord(input)) return undefined;
  const { user, action, resource } = input;
  // The PDP logs a user as an object, or as the key alone: the audit pipeline reads both.
  const key = isRecord(user) ? user['key'] : user;
  if (!nonEmpty(key) || !nonEmpty(action) || !isRecord(resource) || !nonEmpty(resource['type']))
    return undefined;
  const asker: IUser = {
    key,
    ...(isRecord(user) && isRecord(user['attributes']) ? { attributes: user['attributes'] } : {}),
  };
  const target: IResource = {
    type: resource['type'],
    ...(nonEmpty(resource['key']) ? { key: resource['key'] } : {}),
    ...(nonEmpty(resource['tenant']) ? { tenant: resource['tenant'] } : {}),
    ...(isRecord(resource['attributes']) ? { attributes: resource['attributes'] } : {}),
  };
  return { user: asker, action, resource: target };
}

/**
 * The fields of an audit entry the replay reads, from whatever the API sent. An item that is not an
 * object is an entry with nothing in it.
 */
function entryOf(item: unknown): AuditEntry {
  if (!isRecord(item)) return {};
  return {
    ...(typeof item['timestamp'] === 'string' ? { timestamp: item['timestamp'] } : {}),
    ...(typeof item['action'] === 'string' ? { action: item['action'] } : {}),
    ...(typeof item['decision'] === 'boolean' ? { decision: item['decision'] } : {}),
    input: item['input'],
  };
}

/** Whether a failed read may pass if asked again: a 5xx, or no answer at all. */
function worthAskingAgain(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status >= 500;
  return (
    error instanceof NoAnswerError ||
    (error instanceof TypeError && error.message === 'fetch failed')
  );
}

/**
 * GET `path`, asked again after a failure that may pass, waiting AUDIT_RETRY_WAITS_MS between
 * attempts: three attempts in all. Each new attempt is logged, so a slower run says why. The last
 * failure, or one that would not pass, is thrown.
 */
async function getWithRetry(deps: AuditReader, path: string, what: string): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.get(path);
    } catch (error) {
      const wait = AUDIT_RETRY_WAITS_MS[attempt - 1];
      if (wait === undefined || !worthAskingAgain(error)) throw error;
      const status = statusOf(error);
      const why = status === undefined ? 'the API did not answer' : `the API answered ${status}`;
      deps.log?.(
        `  Reading ${what}: ${why}. Asking again in ${wait / 1000} s (attempt ${attempt + 1} of ${AUDIT_RETRY_WAITS_MS.length + 1}).`,
      );
      await (deps.wait ?? sleep)(wait);
    }
  }
}

/** One page of the audit log for the window, newest first. */
async function readPage(
  deps: AuditReader,
  window: ReplayWindow,
  page: number,
): Promise<AuditEntry[]> {
  // Both ends of the window: the audit-log search applies the time range only when it gets
  // timestamp_from and timestamp_to.
  const query = new URLSearchParams({
    timestamp_from: String(Math.floor(window.since / 1000)),
    timestamp_to: String(Math.ceil(window.until / 1000)),
    ...(window.action === undefined ? {} : { action: window.action }),
    page: String(page),
    per_page: String(PAGE_SIZE),
  });
  const path = `/v2/pdps/${encodeURIComponent(window.project)}/${encodeURIComponent(window.environment)}/audit_logs?${query}`;
  const body = await getWithRetry(deps, path, `page ${page} of the audit log`);
  if (!isRecord(body) || !Array.isArray(body['data']))
    throw new Error('The audit-log API answered something other than a page of decisions');
  return body['data'].map(entryOf);
}

/** When the entry was recorded, in ms. Undefined when it has no time that can be read. */
function timeOf(entry: AuditEntry): number | undefined {
  const time = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp);
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Whether the entry belongs to the window and the action. The API filters on both, and this holds
 * it to its word: an entry the filter let through is not replayed, so a search that ignored the
 * time range cannot widen the report.
 */
function belongs(entry: AuditEntry, window: ReplayWindow): boolean {
  const time = timeOf(entry);
  if (time !== undefined && (time < window.since || time > window.until)) return false;
  return (
    window.action === undefined ||
    entry.action === undefined ||
    entry.action.toLowerCase() === window.action.toLowerCase()
  );
}

const resourceOf = (resource: IResource) =>
  resource.key === undefined ? resource.type : `${resource.type}:${resource.key}`;

/**
 * Asks the PDP once for every entry of the page that can be asked again and compared, and adds what
 * came back to `report`.
 */
async function replayPage(
  deps: Pick<ReplayDeps, 'bulkCheck'>,
  entries: readonly AuditEntry[],
  report: ReplayReport,
): Promise<void> {
  const askable = entries.flatMap((entry) => {
    const check = checkFromEntry(entry);
    return check !== undefined && typeof entry.decision === 'boolean'
      ? [{ entry, check, was: entry.decision }]
      : [];
  });
  report.total += entries.length;
  report.unreplayable += entries.length - askable.length;
  if (askable.length === 0) return;
  // Permit check: would today's policy and data decide each check this page of the audit log
  // recorded the same way? One permit.bulkCheck, asked of the local PDP.
  const answers = await deps.bulkCheck(askable.map((a) => a.check));
  if (answers.length !== askable.length)
    throw new Error(
      `The PDP answered ${answers.length} of the ${askable.length} checks it was asked`,
    );
  askable.forEach(({ entry, check, was }, i) => {
    const now = answers[i];
    if (typeof now !== 'boolean')
      throw new Error('The PDP answered a check with something other than allow or deny');
    if (now === was) {
      report.unchanged += 1;
      return;
    }
    report.changed.push({
      at: entry.timestamp ?? 'unknown time',
      user: check.user.key,
      action: check.action,
      resource: resourceOf(check.resource),
      was,
      now,
    });
  });
}

/**
 * Reads the audit log for the window page by page, newest first, and asks the PDP again with one
 * bulk check per page. Throws when a page cannot be read, when the PDP cannot be asked, and when
 * the window holds more than the API lists.
 */
export async function replayAuditLog(
  deps: AuditReader,
  window: ReplayWindow,
): Promise<ReplayReport> {
  const report: ReplayReport = { total: 0, unchanged: 0, changed: [], unreplayable: 0, pages: 0 };
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const entries = await readPage(deps, window, page);
    report.pages += 1;
    await replayPage(
      deps,
      entries.filter((entry) => belongs(entry, window)),
      report,
    );
    // The last page is short. Or the log, newest first, has reached entries from before the window:
    // nothing after them belongs to it.
    if (
      entries.length < PAGE_SIZE ||
      entries.some((entry) => (timeOf(entry) ?? Number.POSITIVE_INFINITY) < window.since)
    )
      return report;
  }
  throw new Error(
    `The audit log lists at most ${(MAX_PAGES * PAGE_SIZE).toLocaleString('en-US')} decisions of one search, and this window may hold more: use a shorter --since, or --action`,
  );
}

/** The project and environment the API key belongs to, from /v2/api-key/scope. */
export async function scopeOf(
  get: ReplayDeps['get'],
): Promise<{ project: string; environment: string }> {
  const body = await get('/v2/api-key/scope');
  if (!isRecord(body) || !nonEmpty(body['project_id']) || !nonEmpty(body['environment_id'])) {
    throw new Error(
      "The API key is not scoped to one environment, so that environment's audit log cannot be read: use the environment key from the profile",
    );
  }
  return { project: body['project_id'], environment: body['environment_id'] };
}

const word = (allow: boolean) => (allow ? 'ALLOW' : 'DENY');
const changeOf = (c: { was: boolean; now: boolean }) => `then ${word(c.was)}, now ${word(c.now)}`;

/**
 * The decisions of one user, action and resource that would change the same way: how many, and the
 * first and last time.
 */
export interface ChangeGroup {
  user: string;
  action: string;
  resource: string;
  was: boolean;
  now: boolean;
  count: number;
  first: string;
  last: string;
}

/**
 * The changes, one group per user, action, resource and change, the largest first (then by user,
 * action and resource). `first` and `last` are the earliest and latest times the group's decisions
 * carry; "unknown time" only when none has one.
 */
export function groupChanges(changed: readonly DecisionChange[]): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup & { firstMs: number; lastMs: number }>();
  for (const c of changed) {
    const key = JSON.stringify([c.user, c.action, c.resource, c.was, c.now]);
    const ms = Date.parse(c.at);
    const group = groups.get(key) ?? {
      user: c.user,
      action: c.action,
      resource: c.resource,
      was: c.was,
      now: c.now,
      count: 0,
      first: c.at,
      last: c.at,
      firstMs: ms,
      lastMs: ms,
    };
    group.count += 1;
    if (!Number.isNaN(ms) && (Number.isNaN(group.firstMs) || ms < group.firstMs))
      Object.assign(group, { first: c.at, firstMs: ms });
    if (!Number.isNaN(ms) && (Number.isNaN(group.lastMs) || ms > group.lastMs))
      Object.assign(group, { last: c.at, lastMs: ms });
    groups.set(key, group);
  }
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        byText(a.user, b.user) ||
        byText(a.action, b.action) ||
        byText(a.resource, b.resource),
    )
    .map(({ firstMs: _first, lastMs: _last, ...group }) => group);
}

/**
 * Rows of text as columns, each as wide as its widest cell, the first column (a count) set to the
 * right.
 */
function columns(rows: readonly string[][]): string[] {
  const widths =
    rows[0]?.map((_cell, i) => Math.max(...rows.map((row) => (row[i] ?? '').length))) ?? [];
  return rows.map(
    (row) =>
      `  ${row
        .map((cell, i) => (i === 0 ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd()}`,
  );
}

function reportLines(report: ReplayReport, pdpUrl: string, details: boolean): string[] {
  if (report.total === 0) {
    return [
      'The audit log lists no decisions in this window. The PDP uploads its decisions in batches, so the newest may not be listed yet.',
    ];
  }
  const lines = [
    `Read ${report.total} decisions on ${report.pages} ${report.pages === 1 ? 'page' : 'pages'} and asked the PDP at ${pdpUrl} again, one bulk check per page.`,
    '',
    `  total           ${report.total}`,
    `  unchanged       ${report.unchanged}`,
    `  would change    ${report.changed.length}`,
    `  not replayable  ${report.unreplayable}${report.unreplayable === 0 ? '' : '  (no recorded decision, or nothing to ask again)'}`,
    '',
  ];
  if (report.changed.length === 0) return [...lines, 'No decision would change.'];
  if (details) {
    return [
      ...lines,
      'Decisions that would change:',
      ...report.changed.map(
        (c) => `  ${c.at}  ${c.user}  ${c.action}  ${c.resource}  ${changeOf(c)}`,
      ),
    ];
  }
  const groups = groupChanges(report.changed);
  return [
    ...lines,
    `Decisions that would change, by user, action, resource and change (${groups.length} ${groups.length === 1 ? 'group' : 'groups'}; --details lists each decision):`,
    ...columns([
      ['count', 'user', 'action', 'resource', 'change', 'first', 'last'],
      ...groups.map((g) => [
        String(g.count),
        g.user,
        g.action,
        g.resource,
        changeOf(g),
        g.first,
        g.last,
      ]),
    ]),
  ];
}

/**
 * Why a fetch got no answer. Node's fetch says only "fetch failed" and keeps the reason in `cause`,
 * which can be an AggregateError, one error per address it tried, with no message of its own.
 */
function noAnswerBecause(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError')
    return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  const cause = error instanceof Error ? error.cause : undefined;
  const reason = cause instanceof AggregateError ? cause.errors[0] : cause;
  const code = isRecord(reason) ? reason['code'] : undefined;
  if (nonEmpty(code)) return code;
  return reason instanceof Error && reason.message !== '' ? reason.message : describeError(error);
}

/**
 * GET on the Permit API with the profile's key. Throws NoAnswerError when there is no answer
 * (saying where and why), an HttpError for a status that is not a success, and an error for an
 * answer that is not JSON. The query is never echoed: the path is enough.
 */
export function permitGet(env: ScriptEnv): ReplayDeps['get'] {
  const base = env.apiUrl.replace(/\/+$/, '');
  return async (path) => {
    const where = path.split('?', 1)[0] ?? path;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${env.apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new NoAnswerError(
        `The Permit API at ${base} did not answer GET ${where}: ${noAnswerBecause(error)}`,
        { cause: error },
      );
    }
    const body = await res.text();
    if (!res.ok)
      throw new HttpError(`GET ${where} answered ${res.status}: ${body.slice(0, 200)}`, res.status);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`GET ${where} did not answer JSON`);
    }
  };
}

function realDeps(env: ScriptEnv): ReplayDeps {
  const permit = scriptPermit(env);
  return {
    get: permitGet(env),
    bulkCheck: (checks) => permit.bulkCheck(checks),
    now: () => Date.now(),
    log: (line) => console.log(line),
    wait: sleep,
  };
}

/**
 * Reads the arguments, replays the window and prints the report. Anything that stops it from
 * reading the whole window is "could not run".
 */
export async function runReplay(
  env: ScriptEnv,
  argv: string[],
  deps: ReplayDeps = realDeps(env),
): Promise<Result> {
  const until = deps.now();
  let args: ReplayArgs;
  try {
    args = parseReplayArgs(argv, until);
  } catch (error) {
    if (error instanceof UsageError)
      return { outcome: 'could-not-run', summary: `${error.message}. ${USAGE}` };
    throw error;
  }
  const since = new Date(args.since).toISOString();
  try {
    deps.log(
      `Replaying profile ${env.profile} (${env.apiUrl}): the decisions in the audit log since ${since}${args.action === undefined ? '' : `, action ${args.action}`}`,
    );
    const { project, environment } = await scopeOf(deps.get);
    const report = await replayAuditLog(deps, {
      project,
      environment,
      since: args.since,
      until,
      action: args.action,
    });
    // Decisions that were read but none of which could be asked again prove nothing. Say so, rather
    // than "no decision would change".
    if (report.total > 0 && report.unchanged + report.changed.length === 0) {
      return {
        outcome: 'could-not-run',
        summary: `the audit log lists ${report.total} decisions in this window, but none of them holds an input and a decision that can be asked again: the entry format may have changed`,
      };
    }
    for (const line of reportLines(report, env.pdpUrl, args.details === true)) deps.log(line);
    return {
      outcome: 'pass',
      summary: `replayed ${report.total} decisions since ${since}: ${report.changed.length} would change`,
    };
  } catch (error) {
    // Never exit 1: a replay that could not read the whole window has no verdict to fail with.
    return { outcome: 'could-not-run', summary: describeError(error) };
  }
}

if (isMain(import.meta.url)) await runCli(() => runReplay(scriptEnv(), process.argv.slice(2)));
