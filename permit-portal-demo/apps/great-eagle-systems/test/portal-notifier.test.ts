import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpPortalNotifier } from '../src/portal-notifier';

interface Received { method: string | undefined; path: string | undefined; contentType: string | undefined; body: unknown }
type Answer = { status: number; body: unknown } | 'never';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A stand-in for the portal's internal API on a free local port. */
async function portalStub(answer: Answer) {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    received.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], body: raw ? JSON.parse(raw) : undefined });
    if (answer === 'never') return;
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  closers.push(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close };
}

function notifierFor(url: string, timeoutMs?: number) {
  const logged: string[] = [];
  return { logged, notifier: new HttpPortalNotifier(url, { timeoutMs, log: (line) => logged.push(line) }) };
}

describe('HttpPortalNotifier', () => {
  it('POSTs { subject, key } as JSON to /internal/facts-changed', async () => {
    const portal = await portalStub({ status: 200, body: { ms: 12 } });
    const { notifier, logged } = notifierFor(`${portal.url}/`);
    expect(await notifier.factsChanged('user', 'eowyn')).toEqual({ ok: true });
    expect(await notifier.factsChanged('org', 'riders-of-rohan')).toEqual({ ok: true });
    expect(portal.received).toEqual([
      { method: 'POST', path: '/internal/facts-changed', contentType: 'application/json', body: { subject: 'user', key: 'eowyn' } },
      { method: 'POST', path: '/internal/facts-changed', contentType: 'application/json', body: { subject: 'org', key: 'riders-of-rohan' } },
    ]);
    expect(logged).toEqual([]);
  });

  it('POSTs to /internal/cleanup-expired and returns how many grant entries were removed', async () => {
    const portal = await portalStub({ status: 200, body: { removed: 2 } });
    const { notifier } = notifierFor(portal.url);
    expect(await notifier.runCleanup()).toEqual({ removed: 2 });
    expect(portal.received).toEqual([{ method: 'POST', path: '/internal/cleanup-expired', contentType: 'application/json', body: {} }]);
  });

  it('counts the entries when the portal lists the removed grants', async () => {
    const portal = await portalStub({ status: 200, body: { removed: [{ resource: 'SHP-77001' }, { resource: 'SHP-77002' }] } });
    expect(await notifierFor(portal.url).notifier.runCleanup()).toEqual({ removed: 2 });
  });

  it('turns an answer without a removed count into an error', async () => {
    const portal = await portalStub({ status: 200, body: { ok: true } });
    expect(await notifierFor(portal.url).notifier.runCleanup()).toEqual({ error: expect.stringContaining('removed') });
  });

  it('returns the portal’s own error for a non-2xx answer and logs the subject and key, not the payload', async () => {
    const portal = await portalStub({ status: 424, body: { error: 'The PDP did not confirm this change within 5 seconds.' } });
    const { notifier, logged } = notifierFor(portal.url);
    expect(await notifier.factsChanged('user', 'eowyn')).toEqual({ error: 'portal answered 424: The PDP did not confirm this change within 5 seconds.' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('user eowyn');
    expect(logged[0]).toContain('424');
  });

  it('returns an error instead of throwing when the portal is unreachable', async () => {
    const portal = await portalStub({ status: 200, body: {} });
    await portal.close();
    const { notifier, logged } = notifierFor(portal.url);
    expect(await notifier.factsChanged('org', 'riders-of-rohan')).toEqual({ error: expect.stringContaining('portal unreachable') });
    expect(await notifier.runCleanup()).toEqual({ error: expect.stringContaining('portal unreachable') });
    expect(logged[0]).toContain('org riders-of-rohan');
  });

  it('gives up on a portal that never answers', async () => {
    // Deliberately time-sensitive: this exercises the request timeout itself.
    const portal = await portalStub('never');
    const { notifier } = notifierFor(portal.url, 50);
    expect(await notifier.factsChanged('user', 'eowyn')).toEqual({ error: 'portal did not answer within 50 ms' });
  });
});
