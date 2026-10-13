// The presenter console's S2 page and its API tester. "Send a grant as Frodo" runs on the
// server side of these systems: the portal has no CORS, so a browser page on this origin could not call it with
// x-demo-persona. The page asks these systems, and they send the one fixed forged grant to the portal.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '#src/app';
import { s2ConsoleRouter } from '#src/console-s2';
import type { PortalNotifier } from '#src/portal-notifier';
import { loadSeed } from '#src/seed';
import { Store } from '#src/store';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');
const FORGED_GRANT = { user: 'merry', role: 'shipper', resource: 'ean:EAN-1002' };

interface Received { method: string | undefined; path: string | undefined; persona: string | undefined; contentType: string | undefined; body: unknown }
type Answer = { status: number; body: unknown } | { status: number; text: string } | 'never';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A stand-in for the portal on a free local port: it records what it is sent and answers `answer`. */
async function portalStub(answer: Answer) {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    received.push({
      method: req.method, path: req.url, persona: req.headers['x-demo-persona'] as string | undefined,
      contentType: req.headers['content-type'], body: raw ? JSON.parse(raw) : undefined,
    });
    if (answer === 'never') return;
    if ('text' in answer) res.writeHead(answer.status, { 'content-type': 'text/html' }).end(answer.text);
    else res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  closers.push(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close };
}

/** The console app with its S2 tester pointed at `portalUrl`. */
function app(portalUrl: string) {
  const notifier: PortalNotifier = { factsChanged: async () => ({ ok: true }), runCleanup: async () => ({ removed: 0 }) };
  return createApp({ store: new Store(loadSeed(), { at: NOW }), notifier, now: () => NOW, portalUrl });
}

const DENIED = { error: 'Permit denied grant_shipper on ean:EAN-1002.', decision: 'deny' };

describe('POST /api/s2/forged-grant', () => {
  it("sends Frodo's forged grant to the portal's grants API as Frodo, and shows the portal's answer verbatim", async () => {
    const portal = await portalStub({ status: 403, body: DENIED });
    const res = await request(app(portal.url)).post('/api/s2/forged-grant');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 403, body: DENIED });
    expect(portal.received).toEqual([{ method: 'POST', path: '/api/s2/grants', persona: 'frodo', contentType: 'application/json', body: FORGED_GRANT }]);
  });

  it('relays any status as it came: a grant the portal accepted is shown as accepted, not as refused', async () => {
    const portal = await portalStub({ status: 201, body: { ms: 612 } });
    const res = await request(app(portal.url)).post('/api/s2/forged-grant');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 201, body: { ms: 612 } });
  });

  it('relays an answer that is not JSON as text', async () => {
    const portal = await portalStub({ status: 502, text: '<h1>Bad gateway</h1>' });
    const res = await request(app(portal.url)).post('/api/s2/forged-grant');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 502, body: '<h1>Bad gateway</h1>' });
  });

  it('sends the same fixed grant whatever the caller posts: the tester is not a relay for other grants', async () => {
    const portal = await portalStub({ status: 403, body: DENIED });
    const res = await request(app(portal.url))
      .post('/api/s2/forged-grant?as=sam')
      .send({ user: 'frodo', role: 'account_admin', resource: 'ean:EAN-1001', persona: 'sam' });
    expect(res.body.status).toBe(403);
    expect(portal.received).toEqual([{ method: 'POST', path: '/api/s2/grants', persona: 'frodo', contentType: 'application/json', body: FORGED_GRANT }]);
  });

  it('copes with a trailing slash on the portal address', async () => {
    const portal = await portalStub({ status: 403, body: DENIED });
    await request(app(`${portal.url}//`)).post('/api/s2/forged-grant');
    expect(portal.received.map((r) => r.path)).toEqual(['/api/s2/grants']);
  });

  it('answers 502 with the reason when the portal cannot be reached, and nothing that looks like a portal answer', async () => {
    const portal = await portalStub({ status: 200, body: {} });
    await portal.close();
    const res = await request(app(portal.url)).post('/api/s2/forged-grant');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: expect.stringMatching(/^The portal did not answer: .+/) });
    expect(res.body).not.toHaveProperty('status');
  });

  it('answers 502 when the portal does not answer in time', async () => {
    const portal = await portalStub('never');
    const slow = express().use(s2ConsoleRouter({ portalUrl: portal.url, timeoutMs: 50 }));
    const res = await request(slow).post('/api/s2/forged-grant');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'The portal did not answer: no answer within 50 ms' });
  });

  it('is a POST only', async () => {
    const portal = await portalStub({ status: 403, body: DENIED });
    expect((await request(app(portal.url)).get('/api/s2/forged-grant')).status).toBe(404);
    expect(portal.received).toEqual([]);
  });
});

describe('GET /s2', () => {
  async function page() {
    const res = await request(app('http://portal.invalid')).get('/s2');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    return res.text;
  }

  it('offers "Send a grant as Frodo" and shows the request before it is sent', async () => {
    const html = await page();
    expect(html).toContain('Send a grant as Frodo');
    expect(html).toContain('id="send-grant"');
    expect(html).toContain('POST /api/s2/grants');
    expect(html).toContain('x-demo-persona: frodo');
    for (const part of ['merry', 'shipper', 'ean:EAN-1002']) expect(html, part).toContain(part);
    // The page shows the portal's status and body where the presenter can see them.
    expect(html).toContain('id="answer-status"');
    expect(html).toContain('id="answer-body"');
  });

  it("asks these systems, same origin, never the portal: the portal has no CORS and the page must not need it", async () => {
    const html = await page();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain("fetch('/api/s2/forged-grant'");
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toContain('x-demo-persona');
  });

  it('keeps its inline script free of backticks, "${" and backslashes, since it lives in a template literal', async () => {
    const html = await page();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(0);
    expect(script).not.toContain('`');
    expect(script).not.toContain('${');
    expect(script).not.toContain('\\');
  });
});
