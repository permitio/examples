import arcjet, {
  type ArcjetBotReason,
  type ArcjetDecision,
  type ArcjetErrorReason,
  detectBot,
  shield,
} from '@arcjet/node';
import { type Classification, type Classifier, userAgentOf } from '#src/classifier';
import type { BotType } from '#src/policy';
import { classifyUserAgent } from '#src/user-agent-classifier';

/**
 * Bots Arcjet identifies that drive a real browser engine, so they can pass for a person's browser.
 * The User-Agent fallback looks for the same three.
 */
const SCRIPTED_BROWSERS = new Set(['HEADLESS_CHROME', 'JAVASCRIPT_PHANTOM', 'CYPRESS']);

/**
 * Arcjet's verdict mapped onto the policy's bot types. Arcjet 1.x no longer reports the bot ranks
 * the policy is named after; it lists the bots it identified and says whether each claim was
 * verified or spoofed, and it knows whether the address belongs to a hosting provider.
 *
 * - Shield found an attack: the request is blocked before Permit is asked.
 * - No User-Agent, a spoofed bot (it claims to be Googlebot, say, from someone else's network) or a
 *   known botnet: NOT_ANALYZED.
 * - A bot whose identity Arcjet verified: VERIFIED_BOT.
 * - A script-driven browser, or a browser User-Agent from a hosting provider's network:
 *   LIKELY_AUTOMATED.
 * - Any other bot Arcjet identified: AUTOMATED.
 * - Nothing found: LIKELY_NOT_A_BOT.
 *
 * When Arcjet could not decide (a bad key, the API unreachable), the User-Agent check decides, and
 * the reason says so.
 */
export function classifyDecision(
  decision: ArcjetDecision,
  userAgent: string | undefined,
): Classification {
  if (decision.isDenied() && decision.reason.isShield())
    return { kind: 'blocked', by: 'arcjet', reason: 'Arcjet Shield found an attack.' };
  const caller = (botType: BotType, reason: string): Classification => ({
    kind: 'caller',
    by: 'arcjet',
    botType,
    reason,
  });
  if (userAgent === undefined) return caller('NOT_ANALYZED', 'It sent no User-Agent.');

  const reasons = decision.results.map((r) => r.reason);
  const bot = reasons.find((r): r is ArcjetBotReason => r.isBot());
  if (bot === undefined) {
    const error = [decision.reason, ...reasons].find((r): r is ArcjetErrorReason => r.isError());
    const why = error?.message ?? 'its bot rule did not run';
    const fallback = classifyUserAgent(userAgent);
    return {
      kind: 'caller',
      by: 'user-agent',
      botType: fallback.botType,
      reason: `Arcjet could not decide (${why}). ${fallback.reason}`,
    };
  }
  const identified = [...bot.denied, ...bot.allowed];
  const names = identified.join(', ');
  if (bot.isSpoofed()) return caller('NOT_ANALYZED', `It claims to be ${names} but is not.`);
  if (identified.some((id) => id.endsWith('_BOTNET')))
    return caller('NOT_ANALYZED', `Arcjet identified a botnet: ${names}.`);
  if (bot.isVerified()) return caller('VERIFIED_BOT', `Arcjet verified it as ${names}.`);
  if (identified.some((id) => SCRIPTED_BROWSERS.has(id)))
    return caller('LIKELY_AUTOMATED', `Arcjet identified a script-driven browser: ${names}.`);
  if (identified.length > 0) return caller('AUTOMATED', `Arcjet identified it as ${names}.`);
  if (decision.ip.isHosting())
    return caller('LIKELY_AUTOMATED', "A browser User-Agent from a hosting provider's network.");
  return caller('LIKELY_NOT_A_BOT', 'Arcjet found no sign of a bot.');
}

export function createArcjetClassifier(key: string): Classifier {
  const aj = arcjet({
    key,
    rules: [
      // DRY_RUN: Arcjet reports the bots it finds and Permit decides what they may do. An empty
      // allow list makes Arcjet report every bot it identifies.
      detectBot({ mode: 'DRY_RUN', allow: [] }),
      shield({ mode: 'LIVE' }),
    ],
  });
  return {
    name: 'arcjet',
    description: 'Arcjet (ARCJET_KEY is set)',
    classify: async (request) => {
      const classification = classifyDecision(await aj.protect(request), userAgentOf(request));
      if (classification.by === 'user-agent')
        console.warn(`Arcjet fallback: ${classification.reason}`);
      return classification;
    },
  };
}
