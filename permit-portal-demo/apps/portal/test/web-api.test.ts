import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, decideRequest, emptyFeed, explainEvent, FEED_SIZE, getPersona, isShown, mergeFeed, setPersona } from '../src/web/api';
import type { CheckEvent, WriteEvent } from '../src/web/types';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('sends the current persona in x-demo-persona', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { profile: 'staging' }));
    setPersona('aragorn');

    await expect(api.get('/api/meta')).resolves.toEqual({ profile: 'staging' });

    expect(getPersona()).toBe('aragorn');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/meta');
    expect(init).toMatchObject({ method: 'GET', headers: { 'x-demo-persona': 'aragorn' } });
    expect(init?.body).toBeUndefined();
  });

  it('sends a POST body as JSON', async () => {
    const fetchMock = stubFetch(() => jsonResponse(201, { id: 'req-1' }));
    setPersona('frodo');

    await api.post('/api/s4/shipments/SHP-77001/invitations', { user: 'aragorn', reason: 'customs clearance' });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-persona': 'frodo' } });
    expect(JSON.parse(String(init?.body))).toEqual({ user: 'aragorn', reason: 'customs clearance' });
  });

  it('marks a call as a background refresh with x-demo-source only when the call asks for it', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, {}));

    await api.get('/api/s4/shipments');
    await api.get('/api/events?since=0', { source: 'refresh' });
    await api.post('/api/checks/bulk', { checks: [] });
    await api.post('/api/checks/bulk', { checks: [] }, { source: 'refresh' });

    expect(fetchMock.mock.calls.map(([, init]) => headersOf(init)['x-demo-source'])).toEqual([undefined, 'refresh', undefined, 'refresh']);
  });

  it('throws ApiError carrying the status, the error text and the decision on a non-2xx response', async () => {
    stubFetch(() => jsonResponse(403, { error: 'Renewal not allowed by policy', decision: 'deny' }));

    const error = await api.post('/api/s4/shipments/SHP-77001/renewals', { days: 45 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: 'Renewal not allowed by policy', decision: 'deny' });
  });

  it('surfaces a 424 error text unchanged', async () => {
    const text = 'The PDP did not confirm this change within 5 seconds.';
    stubFetch(() => jsonResponse(424, { error: text }));

    const error = await api.post('/api/requests/req-1/approve').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 424, message: text, decision: undefined });
  });

  it('approves with a comment only when one was written, and always sends the comment with a deny', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { request: { id: 'req 1' }, ms: 12 }));
    const bodies = () => fetchMock.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body))]);

    await decideRequest('req 1', 'approve', '  ');
    await decideRequest('req 1', 'approve', ' looks right ');
    await decideRequest('req 1', 'deny', '');

    expect(bodies()).toEqual([
      ['/api/requests/req%201/approve', {}],
      ['/api/requests/req%201/approve', { comment: 'looks right' }],
      ['/api/requests/req%201/deny', { comment: '' }],
    ]);
  });

  it('asks the portal to explain one recorded check, as a user action', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { reason: { abac: { allow: false } }, allow: false }));

    await expect(explainEvent(42)).resolves.toEqual({ reason: { abac: { allow: false } }, allow: false });

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/events/42/explain');
    expect(init?.method).toBe('POST');
    expect(headersOf(init)['x-demo-source']).toBeUndefined();
  });

  it('names the status when an error response has no JSON body', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(api.get('/api/meta')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
  });
});

describe('persona storage', () => {
  it('starts as frodo when the browser storage is unavailable', async () => {
    vi.resetModules();
    const fresh = await import('../src/web/api');

    expect(fresh.getPersona()).toBe('frodo');
  });

  it('restores the saved persona and saves a new choice', async () => {
    const saved = new Map([['persona', 'sam']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
    vi.resetModules();
    const fresh = await import('../src/web/api');

    expect(fresh.getPersona()).toBe('sam');
    fresh.setPersona('gandalf');
    expect(fresh.getPersona()).toBe('gandalf');
    expect(saved.get('persona')).toBe('gandalf');
  });
});

const check = (id: number, extra: Partial<CheckEvent> = {}): CheckEvent => ({
  id,
  kind: 'check',
  at: 1_000 + id,
  user: 'aragorn',
  action: 'view',
  resource: 'shipment:SHP-77001',
  tenant: 'shire-freight',
  allow: false,
  ms: 1.2,
  input: { user: { key: 'aragorn' } },
  source: 'action',
  ...extra,
});
const write = (id: number): WriteEvent => ({ id, kind: 'write', at: 1_000 + id, what: 'grant aragorn collaborator', ms: 40, ok: true, source: 'action' });

describe('decision feed (GET /api/events)', () => {
  it('adds new events newest first and keeps the newest 200', () => {
    const events = Array.from({ length: 250 }, (_, i) => write(i + 1));

    const feed = mergeFeed(emptyFeed, { events, lastId: 250 });

    expect(feed.events).toHaveLength(FEED_SIZE);
    expect(feed.events[0]?.id).toBe(250);
    expect(feed.events.at(-1)?.id).toBe(51);
    expect(feed.lastId).toBe(250);
  });

  it('keeps the newest 200 decisions the presenter made however many page refreshes follow them', () => {
    const actions = Array.from({ length: 10 }, (_, i) => check(i + 1));
    const refreshes = Array.from({ length: 500 }, (_, i) => check(i + 11, { source: 'refresh' }));

    const feed = mergeFeed(mergeFeed(emptyFeed, { events: actions, lastId: 10 }), { events: refreshes, lastId: 510 });

    expect(feed.events.filter((e) => e.source !== 'refresh').map((e) => e.id)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(feed.events.filter((e) => e.source === 'refresh')).toHaveLength(FEED_SIZE);
    expect(feed.events[0]?.id).toBe(510);
  });

  it('keeps an event the presenter has open even after FEED_SIZE newer ones arrive', () => {
    const opened = mergeFeed(emptyFeed, { events: [check(1)], lastId: 1 });
    const flood = Array.from({ length: FEED_SIZE + 50 }, (_, i) => write(i + 2));

    const after = mergeFeed(opened, { events: flood, lastId: FEED_SIZE + 51 }, new Set([1]));

    expect(after.events).toHaveLength(FEED_SIZE + 1);
    expect(after.events[0]?.id).toBe(FEED_SIZE + 51);
    expect(after.events.at(-1)?.id).toBe(1);
  });

  it('starts over from id 0 when the portal restarts and its event ids go back', () => {
    const before = mergeFeed(emptyFeed, { events: [check(41), check(42)], lastId: 42 });

    // The poll that notices the restart asked for ids above 42, so it saw none of the new log's events.
    const after = mergeFeed(before, { events: [], lastId: 3 }, new Set([42]));

    expect(after).toEqual(emptyFeed);
    const reread = mergeFeed(after, { events: [write(1), write(2), write(3)], lastId: 3 });
    expect(reread.events.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('hides page refreshes unless the presenter asks to see them', () => {
    const refresh = check(1, { source: 'refresh' });

    expect(isShown(refresh, false)).toBe(false);
    expect(isShown(refresh, true)).toBe(true);
    expect(isShown(check(2, { source: 'action' }), false)).toBe(true);
    expect(isShown(check(3, { source: 'guard' }), false)).toBe(true);
    expect(isShown(check(4, { source: undefined }), false)).toBe(true);
  });
});

describe('a portal rebuilt under an open tab', () => {
  const answer = (build?: string) => new Response('{}', { status: 200, headers: build ? { 'x-portal-build': build } : {} });

  it('stays quiet while every answer names the build of the first one, and says so once when another appears', async () => {
    vi.resetModules();
    const fresh = await import('../src/web/api');
    const heard = vi.fn();
    fresh.onPortalRebuilt(heard);
    const builds = [undefined, 'aaa', 'aaa', undefined, 'bbb', 'ccc'];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => answer(builds.shift())));

    for (let i = 0; i < 4; i += 1) await fresh.api.get('/api/meta');
    expect(fresh.portalRebuilt()).toBe(false);
    await fresh.api.get('/api/meta');
    expect(fresh.portalRebuilt()).toBe(true);
    await fresh.api.get('/api/meta');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
