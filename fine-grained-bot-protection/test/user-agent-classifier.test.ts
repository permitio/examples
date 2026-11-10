import { describe, expect, it } from 'vitest';
import { classifyUserAgent, userAgentClassifier } from '#src/user-agent-classifier';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/142.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like ' +
  'Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const HEADLESS =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'HeadlessChrome/142.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const GPTBOT =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; ' +
  '+https://openai.com/gptbot';

describe('classifyUserAgent', () => {
  it.each([
    ['no User-Agent', undefined, 'NOT_ANALYZED'],
    ['headless Chrome', HEADLESS, 'LIKELY_AUTOMATED'],
    [
      'PhantomJS',
      'Mozilla/5.0 (Unknown; Linux x86_64) PhantomJS/2.1.1 Safari/538.1',
      'LIKELY_AUTOMATED',
    ],
    ['Cypress', `${CHROME} Cypress/13.6.0`, 'LIKELY_AUTOMATED'],
    ['Googlebot', GOOGLEBOT, 'AUTOMATED'],
    ['GPTBot', GPTBOT, 'AUTOMATED'],
    ['curl', 'curl/8.11.1', 'AUTOMATED'],
    ['wget', 'Wget/1.24.5', 'AUTOMATED'],
    ['python-requests', 'python-requests/2.32.3', 'AUTOMATED'],
    ['Node fetch (undici)', 'undici', 'AUTOMATED'],
    ['a program that is not a browser', 'InventorySync/3.1', 'AUTOMATED'],
    ['Chrome', CHROME, 'LIKELY_NOT_A_BOT'],
    ['Firefox', FIREFOX, 'LIKELY_NOT_A_BOT'],
    ['Safari on an iPhone', SAFARI_IPHONE, 'LIKELY_NOT_A_BOT'],
  ] as const)('classifies %s as %s', (_name, userAgent, botType) => {
    expect(classifyUserAgent(userAgent).botType).toBe(botType);
  });

  it('never reports a verified bot, even for a Googlebot User-Agent', () => {
    expect(classifyUserAgent(GOOGLEBOT).botType).not.toBe('VERIFIED_BOT');
  });

  it('gives a reason for every verdict', () => {
    for (const ua of [undefined, HEADLESS, GOOGLEBOT, CHROME, 'x'])
      expect(classifyUserAgent(ua).reason).toMatch(/\w/);
  });
});

describe('userAgentClassifier', () => {
  it('reads the request header', async () => {
    const result = await userAgentClassifier.classify({ headers: { 'user-agent': 'curl/8.11.1' } });
    expect(result).toEqual({
      kind: 'caller',
      by: 'user-agent',
      botType: 'AUTOMATED',
      reason: expect.any(String),
    });
  });

  it('treats a blank User-Agent as none', async () => {
    const result = await userAgentClassifier.classify({ headers: { 'user-agent': '   ' } });
    expect(result).toMatchObject({ kind: 'caller', botType: 'NOT_ANALYZED' });
  });

  it('treats a request without headers as one without a User-Agent', async () => {
    const result = await userAgentClassifier.classify({});
    expect(result).toMatchObject({ kind: 'caller', botType: 'NOT_ANALYZED' });
  });
});
