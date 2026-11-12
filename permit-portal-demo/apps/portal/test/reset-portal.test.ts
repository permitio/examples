// What bin/demo reset does to the running portal's decision log (scripts/reset.ts): the real
// portal app on a local port, so the request the script sends is the one the route accepts.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScriptEnv } from '#scripts/lib/env';
import { clearPortalLog } from '#scripts/reset';
import { harness } from '#test/fakes';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function serve(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const envAt = (portalUrl: string): ScriptEnv => ({
  profile: 'test',
  apiUrl: 'http://permit.invalid',
  apiKey: 'test-api-key',
  pdpUrl: 'http://pdp.invalid:7766',
  greatEagleSystemsUrl: 'http://systems.invalid',
  portalUrl,
});

describe('reset: the portal decision log', () => {
  it("empties the running portal's log, so the panel drops checks decided before the reset", async () => {
    const { app, events } = harness();
    events.push({ kind: 'write', at: 1, what: 'create tenant riders-of-rohan', ms: 2, ok: true });
    const last = events.lastId();
    const url = await serve(createServer(app));

    expect(await clearPortalLog(envAt(url))).toBe('cleared');

    expect(events.since(0)).toEqual([]);
    expect(events.clearedThrough()).toBe(last);
  });

  it('skips, with a warning, when the portal is not running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closed = createServer();
    const url = await serve(closed);
    await new Promise((resolve) => closed.close(resolve));
    servers.splice(servers.indexOf(closed), 1);

    expect(await clearPortalLog(envAt(url))).toBe('skipped');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not POST \/api\/events\/clear, the portal is not reachable/),
    );
  });

  it('fails the reset when the portal answers with an error', async () => {
    const url = await serve(
      createServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Pick a persona' }));
      }),
    );

    await expect(clearPortalLog(envAt(url))).rejects.toThrow(
      'the portal answered 401 to POST /api/events/clear with x-demo-persona aragorn',
    );
  });
});
