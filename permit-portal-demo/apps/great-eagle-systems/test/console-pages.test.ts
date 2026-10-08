// The presenter console's pages: the main console at / and one page per scenario (S2, S5, S8), all in the same
// shell, whose header links every page. These hold for every scenario page.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { PortalNotifier } from '../src/portal-notifier';
import { loadSeed } from '../src/seed';
import { Store } from '../src/store';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');
const PAGES = ['/', '/s2', '/s5', '/s8'];

function app() {
  const notifier: PortalNotifier = { factsChanged: async () => ({ ok: true }), runCleanup: async () => ({ removed: 0 }) };
  return createApp({ store: new Store(loadSeed(), { at: NOW }), notifier, now: () => NOW });
}

/** The header's page links, in order, and the one marked as the current page. */
function navOf(html: string): { links: string[]; current: string[] } {
  const nav = /<nav\b[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  const anchors = [...nav.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1] ?? '');
  const hrefOf = (attrs: string) => /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? '';
  return { links: anchors.map(hrefOf), current: anchors.filter((a) => /\baria-current="page"/.test(a)).map(hrefOf) };
}

describe('presenter console pages', () => {
  it("links the S2, S5 and S8 pages from the main console's header", async () => {
    const res = await request(app()).get('/');
    expect(res.status).toBe(200);
    expect(navOf(res.text)).toEqual({ links: PAGES, current: ['/'] });
  });

  it.each(['/s2', '/s5', '/s8'])('serves %s in the console shell, with the same header', async (path) => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toMatch(/<title>[^<]*Great Eagle systems \(simulated\)<\/title>/);
    expect(navOf(res.text)).toEqual({ links: PAGES, current: [path] });
  });
});
