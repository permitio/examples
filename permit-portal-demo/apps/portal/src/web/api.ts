// The portal API client. Every call names the current demo persona in x-demo-persona;
// errors keep the server's own text, so a 424 or a policy deny reaches the screen word for word.

import type {
  ApproveResponse,
  DemoEvent,
  DenyResponse,
  EventsResponse,
  ExplainResponse,
} from '@/types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly decision?: 'deny',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const DEFAULT_PERSONA = 'frodo';

let persona = (() => {
  try {
    return localStorage.getItem('persona') ?? DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
})();

export const getPersona = () => persona;

export function setPersona(p: string) {
  persona = p;
  try {
    localStorage.setItem('persona', p);
  } catch {
    /* private window: the choice lasts until the page reloads */
  }
}

export interface CallOptions {
  /**
   * 'refresh' marks a request nobody asked for: a page re-reading itself on a timer, or the
   * decision feed's poll. The portal tags the events it records for such a request, and the
   * decision panel hides them by default.
   */
  source?: 'refresh';
}

/**
 * The web build named by the first API answer this tab got, and whether a later answer named
 * another one.
 */
let firstBuild: string | null = null;
let rebuilt = false;
const rebuiltListeners = new Set<() => void>();

/**
 * Notes the build the portal says it serves (`x-portal-build`). A different build than the first
 * answer's means the portal was rebuilt while this tab kept running the old page, which then calls
 * the new API with the old code.
 */
function noteBuild(build: string | null): void {
  if (!build) return;
  if (firstBuild === null) firstBuild = build;
  else if (build !== firstBuild && !rebuilt) {
    rebuilt = true;
    for (const listener of rebuiltListeners) listener();
  }
}

/** True once the portal answered from a newer web build than the one this tab loaded. */
export const portalRebuilt = () => rebuilt;

export function onPortalRebuilt(listener: () => void): () => void {
  rebuiltListeners.add(listener);
  return () => {
    rebuiltListeners.delete(listener);
  };
}

async function call<T>(
  method: string,
  path: string,
  body: unknown,
  { source }: CallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-demo-persona': persona,
  };
  if (source) headers['x-demo-source'] = source;
  const res = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  noteBuild(res.headers.get('x-portal-build'));
  const data = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    decision?: unknown;
  } | null;
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data?.decision === 'deny' ? 'deny' : undefined);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string, opts?: CallOptions) => call<T>('GET', p, undefined, opts),
  post: <T>(p: string, b?: unknown, opts?: CallOptions) => call<T>('POST', p, b ?? {}, opts),
  delete: <T>(p: string, b?: unknown, opts?: CallOptions) => call<T>('DELETE', p, b ?? {}, opts),
};

export const hasStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status;

/**
 * POST /api/requests/:id/approve or /deny. A deny always carries its comment; an approve only when
 * one was written.
 */
export function decideRequest(
  id: string,
  verdict: 'approve',
  comment: string,
  durationMs?: number,
): Promise<ApproveResponse>;
export function decideRequest(id: string, verdict: 'deny', comment: string): Promise<DenyResponse>;
export function decideRequest(
  id: string,
  verdict: 'approve' | 'deny',
  comment: string,
  durationMs?: number,
): Promise<ApproveResponse | DenyResponse> {
  const path = `/api/requests/${encodeURIComponent(id)}/${verdict}`;
  const text = comment.trim();
  if (verdict === 'deny') return api.post<DenyResponse>(path, { comment: text });
  return api.post<ApproveResponse>(path, {
    ...(text ? { comment: text } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

/**
 * POST /api/events/:id/explain: the PDP's verbatim reason for a recorded check, replayed when the
 * presenter asks.
 */
export const explainEvent = (id: number) => api.post<ExplainResponse>(`/api/events/${id}/explain`);

// The decision feed, polled from GET /api/events?since=<lastId>.

/**
 * The newest events of each kind kept: decisions the presenter caused, and page refreshes, counted
 * apart.
 */
export const FEED_SIZE = 200;

export interface FeedState {
  /** Newest first: up to FEED_SIZE of each kind, plus any older rows the presenter still has open. */
  events: DemoEvent[];
  lastId: number;
}

export const emptyFeed: FeedState = { events: [], lastId: 0 };

const isRefresh = (event: DemoEvent) => event.source === 'refresh';

/** Whether the panel lists an event: page refreshes only when the presenter asks to see them. */
export const isShown = (event: DemoEvent, showRefreshes: boolean) =>
  showRefreshes || !isRefresh(event);

/**
 * Folds one poll into the feed. Page refreshes are capped separately, so a page re-reading itself
 * every few seconds never pushes the presenter's own decisions out, and rows in `keep` (open in the
 * panel) stay too. Ids going back means the portal restarted: that poll asked for ids above the old
 * log's last one, so it missed the start of the new log, and the feed starts over from id 0.
 */
export function mergeFeed(
  feed: FeedState,
  res: EventsResponse,
  keep: ReadonlySet<number> = new Set(),
): FeedState {
  if (res.lastId < feed.lastId) return emptyFeed;
  const byId = new Map<number, DemoEvent>(feed.events.map((e) => [e.id, e]));
  for (const event of res.events) byId.set(event.id, event);
  let refreshes = 0;
  let others = 0;
  const events = [...byId.values()]
    .sort((a, b) => b.id - a.id)
    .filter((e) => (isRefresh(e) ? ++refreshes : ++others) <= FEED_SIZE || keep.has(e.id));
  return { events, lastId: Math.max(feed.lastId, res.lastId) };
}
