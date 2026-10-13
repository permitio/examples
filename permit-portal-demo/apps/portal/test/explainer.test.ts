import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PdpExplainer } from '#src/server/permit/explainer';

interface Seen { method?: string | undefined; url?: string | undefined; authorization?: string | undefined; body: unknown }

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A stand-in for the PDP's POST /allowed that records what it was sent. */
async function startPdp(reply: { status: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const input = {
  user: { key: 'aragorn', attributes: { current_time: 1_000_000 } },
  action: 'view',
  resource: { type: 'shipment', key: 'SHP-77001', tenant: 'shire-freight', attributes: { id: 'SHP-77001' } },
};

describe('PdpExplainer', () => {
  it("posts the check input with an empty context and the bearer key, and returns debug verbatim with the replay's decision", async () => {
    const debug = { rbac: { allow: false, code: 'no_permission', reason: "user 'aragorn' does not match any rule" }, abac: { allow: false } };
    const pdp = await startPdp({ status: 200, body: { allow: false, debug } });
    await expect(new PdpExplainer(pdp.url, 'test-api-key').explain(input)).resolves.toEqual({ reason: debug, allow: false });
    expect(pdp.seen).toEqual([{ method: 'POST', url: '/allowed', authorization: 'Bearer test-api-key', body: { ...input, context: {} } }]);
  });

  it('accepts a PDP URL with a trailing slash', async () => {
    const pdp = await startPdp({ status: 200, body: { allow: true, debug: { ok: 1 } } });
    await expect(new PdpExplainer(`${pdp.url}/`, 'k').explain(input)).resolves.toEqual({ reason: { ok: 1 }, allow: true });
    expect(pdp.seen[0]?.url).toBe('/allowed');
  });

  it('returns a null reason when the PDP sends no debug block (debug mode off), and still its decision', async () => {
    const pdp = await startPdp({ status: 200, body: { allow: true } });
    await expect(new PdpExplainer(pdp.url, 'k').explain(input)).resolves.toEqual({ reason: null, allow: true });
  });

  it('answers a null decision when the body carries no boolean allow', async () => {
    const pdp = await startPdp({ status: 200, body: { debug: { x: 1 } } });
    await expect(new PdpExplainer(pdp.url, 'k').explain(input)).resolves.toEqual({ reason: { x: 1 }, allow: null });
  });

  it('reports a non-2xx answer as an error reason with no decision', async () => {
    const pdp = await startPdp({ status: 500, body: { detail: 'boom' } });
    await expect(new PdpExplainer(pdp.url, 'k').explain(input)).resolves.toEqual({ reason: { error: 'PDP answered 500' }, allow: null });
  });

  it('resolves a network failure to an error reason instead of throwing', async () => {
    const pdp = await startPdp({ status: 200, body: {} });
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const result = await new PdpExplainer(pdp.url, 'k').explain(input);
    expect(result).toEqual({ reason: { error: expect.any(String) }, allow: null });
  });
});
