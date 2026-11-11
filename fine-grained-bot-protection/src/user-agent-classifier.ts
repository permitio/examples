import { type Classifier, userAgentOf } from '#src/classifier';
import type { BotType } from '#src/policy';

/**
 * The fallback classifier, used when ARCJET_KEY is not set. It reads only the User-Agent header,
 * which any client can set to anything, so it shows how the policy works and protects nothing. It
 * never reports VERIFIED_BOT: telling a real Googlebot from a copy takes the caller's network
 * address, which is what Arcjet checks.
 *
 * The first rule that matches the User-Agent decides:
 *
 * 1. Missing or empty: NOT_ANALYZED, an evil bot hiding what it is.
 * 2. A script-driven browser (HeadlessChrome, PhantomJS, Cypress): LIKELY_AUTOMATED.
 * 3. Names a bot, crawler or HTTP tool (Googlebot, GPTBot, curl): AUTOMATED.
 * 4. A browser (`Mozilla/5.0 (…`): LIKELY_NOT_A_BOT, a human.
 * 5. Anything else: AUTOMATED, since it does not claim to be a browser.
 */

const SCRIPTED_BROWSER = /HeadlessChrome|PhantomJS|Cypress/i;
const SELF_NAMED_BOT = new RegExp(
  [
    'bot',
    'crawl',
    'spider',
    'slurp',
    'curl/',
    'wget/',
    'httpie',
    'python-',
    'aiohttp',
    'scrapy',
    'go-http-client',
    'java/',
    'okhttp',
    'axios/',
    'node-fetch',
    'undici',
    'postman',
    'libwww-perl',
  ].join('|'),
  'i',
);
const BROWSER = /^Mozilla\/5\.0 \(/;

export interface UserAgentVerdict {
  botType: BotType;
  reason: string;
}

export function classifyUserAgent(userAgent: string | undefined): UserAgentVerdict {
  if (userAgent === undefined)
    return { botType: 'NOT_ANALYZED', reason: 'It sent no User-Agent, hiding what it is.' };
  if (SCRIPTED_BROWSER.test(userAgent))
    return {
      botType: 'LIKELY_AUTOMATED',
      reason: 'Its User-Agent is a browser driven by a script, posing as a person.',
    };
  if (SELF_NAMED_BOT.test(userAgent))
    return {
      botType: 'AUTOMATED',
      reason: 'Its User-Agent names a bot, crawler or HTTP tool.',
    };
  if (BROWSER.test(userAgent))
    return { botType: 'LIKELY_NOT_A_BOT', reason: 'Its User-Agent is a browser.' };
  return {
    botType: 'AUTOMATED',
    reason: 'Its User-Agent does not claim to be a browser, so it is a program.',
  };
}

export const userAgentClassifier: Classifier = {
  name: 'user-agent',
  description: 'User-Agent check (ARCJET_KEY is not set)',
  classify: async (request) => ({
    kind: 'caller',
    by: 'user-agent',
    ...classifyUserAgent(userAgentOf(request)),
  }),
};
