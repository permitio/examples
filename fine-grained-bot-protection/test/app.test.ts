import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '#src/app';
import type { Classification, Classifier } from '#src/classifier';
import { PERSONAS } from '#src/personas';
import { userAgentClassifier } from '#src/user-agent-classifier';
import { fakePermit } from '#test/fake-permit';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/142.0.0.0 Safari/537.36';
const HEADLESS =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'HeadlessChrome/142.0.0.0 Safari/537.36';

function setup(classifier: Classifier = userAgentClassifier) {
  const permit = fakePermit();
  return { app: createApp({ classifier, permit }), permit };
}

function stubClassifier(classification: Classification): Classifier {
  return { name: 'arcjet', description: 'stub', classify: vi.fn(async () => classification) };
}

/** Sends a request with this User-Agent, or with none when it is null. */
function get(app: ReturnType<typeof setup>['app'], path: string, userAgent: string | null) {
  const req = request(app).get(path);
  return userAgent === null ? req.unset('User-Agent') : req.set('User-Agent', userAgent);
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('GET /api/items', () => {
  it.each([
    ['a human', CHROME, ['Public Item', 'Shared Item', 'Private Item']],
    ['a trusted bot', 'curl/8.11.1', ['Public Item', 'Shared Item', 'Private Item']],
    ['an untrusted bot', HEADLESS, ['Public Item', 'Shared Item']],
    ['an evil bot', null, []],
  ] as const)('lists to %s only the items Permit lets it read', async (_who, ua, names) => {
    const { app } = setup();
    const res = await get(app, '/api/items', ua);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(names);
  });

  it('reports how it classified the caller', async () => {
    const { app } = setup();
    const res = await get(app, '/api/items', 'curl/8.11.1');
    expect(res.body.caller).toEqual({
      userAgent: 'curl/8.11.1',
      classifiedBy: 'user-agent',
      botType: 'AUTOMATED',
      userSet: 'Trusted_Bots',
      reason: expect.any(String),
    });
  });

  it("asks Permit once, a check per item and action, with the caller's bot type", async () => {
    const { app, permit } = setup();
    await get(app, '/api/items', HEADLESS);
    expect(permit.bulkCheck).toHaveBeenCalledTimes(1);
    const checks = permit.bulkCheck.mock.calls[0]?.[0] ?? [];
    expect(checks).toHaveLength(16);
    expect(checks[0]).toEqual({
      user: { key: 'user@example.com', attributes: { botType: 'LIKELY_AUTOMATED' } },
      action: 'read',
      resource: { type: 'Content_Item', attributes: { owner: 'user@example.com', private: false } },
    });
    expect(checks.map((c) => c.action).slice(0, 4)).toEqual(['read', 'create', 'update', 'delete']);
  });

  it('answers 502 with the reason, on one line, when the PDP fails', async () => {
    const { app, permit } = setup();
    const sdkError = 'Permit SDK got error: \n connect ECONNREFUSED 127.0.0.1:7766 \n\n   and more';
    permit.bulkCheck.mockRejectedValueOnce(new Error(sdkError));
    const res = await get(app, '/api/items', CHROME);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error:
        "Permit's PDP did not answer: Permit SDK got error: connect ECONNREFUSED " +
        '127.0.0.1:7766 and more',
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it('answers 502 when the PDP returns fewer answers than checks', async () => {
    const { app, permit } = setup();
    permit.bulkCheck.mockResolvedValueOnce([]);
    const res = await get(app, '/api/items', CHROME);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('asked 16 checks, got 0 answers');
  });

  it('answers 403 without asking Permit when Arcjet blocks the request', async () => {
    const classifier = stubClassifier({
      kind: 'blocked',
      by: 'arcjet',
      reason: 'Arcjet Shield found an attack.',
    });
    const { app, permit } = setup(classifier);
    const res = await get(app, '/api/items', CHROME);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Arcjet Shield found an attack.',
      caller: { blocked: true },
    });
    expect(permit.bulkCheck).not.toHaveBeenCalled();
  });

  it('answers 500 without details when the classifier fails', async () => {
    const classifier: Classifier = {
      name: 'arcjet',
      description: 'stub',
      classify: async () => {
        throw new Error('boom');
      },
    };
    const { app } = setup(classifier);
    const res = await get(app, '/api/items', CHROME);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
  });
});

/** How many cells of Permit's decision table say Allow. */
const allows = (html: string) => html.split('class="allow"').length - 1;

describe('GET / (the demo page)', () => {
  it("shows how the browser's own request was classified and what Permit allows", async () => {
    const { app } = setup();
    const res = await get(app, '/', CHROME);
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('<code>LIKELY_NOT_A_BOT</code>');
    expect(res.text).toContain('<code>Human_Users</code>');
    expect(res.text).toContain('A User-Agent check classifies each request');
    expect(res.text).toContain('<a href="/" aria-current="page">');
    // A human may do everything on its own items and read the shared one: 4 + 4 + 1.
    expect(allows(res.text)).toBe(9);
  });

  it.each([
    ['human', 'LIKELY_NOT_A_BOT', 'Human_Users', 9],
    ['trusted-bot', 'AUTOMATED', 'Trusted_Bots', 3],
    ['untrusted-bot', 'LIKELY_AUTOMATED', 'Untrusted_Bots', 2],
    ['evil-bot', 'NOT_ANALYZED', 'Evil_Bots', 0],
  ] as const)('sends the request as the %s persona', async (persona, botType, userSet, count) => {
    const { app } = setup();
    // The browser's own User-Agent is replaced, so it does not matter what it is.
    const res = await get(app, `/?as=${persona}`, 'curl/8.11.1');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<code>${botType}</code>`);
    expect(res.text).toContain(`<code>${userSet}</code>`);
    expect(res.text).toContain(`<a href="/?as=${persona}" aria-current="page">`);
    expect(allows(res.text)).toBe(count);
  });

  it("hands the classifier the persona's User-Agent, or none", async () => {
    const classifier = stubClassifier({
      kind: 'caller',
      by: 'arcjet',
      botType: 'AUTOMATED',
      reason: 'stub',
    });
    const { app } = setup(classifier);
    await get(app, '/?as=trusted-bot', CHROME);
    await get(app, '/?as=evil-bot', CHROME);
    const calls = vi.mocked(classifier.classify).mock.calls.map(([req]) => req.headers);
    expect(calls[0]?.['user-agent']).toBe(PERSONAS[1].userAgent);
    expect(calls[1]).not.toHaveProperty('user-agent');
  });

  it.each(['/?as=robot', '/?as=human&as=evil-bot'])('rejects %s with 400', async (path) => {
    const { app, permit } = setup();
    const res = await get(app, path, CHROME);
    expect(res.status).toBe(400);
    expect(res.text).toBe(
      'Unknown persona. Use one of: human, trusted-bot, untrusted-bot, evil-bot.',
    );
    expect(permit.bulkCheck).not.toHaveBeenCalled();
  });

  it('escapes the User-Agent it shows', async () => {
    const { app } = setup();
    const res = await get(app, '/', 'Mozilla/5.0 (<script>alert(1)</script>)');
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows the PDP error with 502 and no decisions', async () => {
    const { app, permit } = setup();
    permit.bulkCheck.mockRejectedValueOnce(new Error('timeout of 5000ms exceeded'));
    const res = await get(app, '/', CHROME);
    expect(res.status).toBe(502);
    expect(res.text).toContain('Permit&#39;s PDP did not answer: timeout of 5000ms exceeded');
    expect(allows(res.text)).toBe(0);
  });

  it('shows a blocked request with 403 and does not ask Permit', async () => {
    const classifier = stubClassifier({
      kind: 'blocked',
      by: 'arcjet',
      reason: 'Arcjet Shield found an attack.',
    });
    const { app, permit } = setup(classifier);
    const res = await get(app, '/', CHROME);
    expect(res.status).toBe(403);
    expect(res.text).toContain('Blocked before Permit was asked: Arcjet Shield found an attack.');
    expect(res.text).toContain('Arcjet classifies each request.');
    expect(permit.bulkCheck).not.toHaveBeenCalled();
  });
});
