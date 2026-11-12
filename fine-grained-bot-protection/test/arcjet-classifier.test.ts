import {
  ArcjetAllowDecision,
  ArcjetBotReason,
  ArcjetDenyDecision,
  ArcjetErrorDecision,
  ArcjetErrorReason,
  ArcjetIpDetails,
  ArcjetReason,
  ArcjetRuleResult,
  ArcjetShieldReason,
} from '@arcjet/node';
import { describe, expect, it } from 'vitest';
import { classifyDecision } from '#src/arcjet-classifier';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/142.0.0.0 Safari/537.36';

function result(reason: ArcjetReason, conclusion: 'ALLOW' | 'DENY' = 'ALLOW') {
  return new ArcjetRuleResult({
    ruleId: 'rule',
    fingerprint: 'fingerprint',
    ttl: 0,
    state: 'DRY_RUN',
    conclusion,
    reason,
  });
}

/** The bot rule's result, as Arcjet reports it in DRY_RUN with an empty allow list. */
function bot(init: { denied?: string[]; verified?: boolean; spoofed?: boolean } = {}) {
  const reason = new ArcjetBotReason({
    allowed: [],
    denied: init.denied ?? [],
    verified: init.verified ?? false,
    spoofed: init.spoofed ?? false,
  });
  return result(reason, reason.denied.length > 0 ? 'DENY' : 'ALLOW');
}

function allowed(results: ArcjetRuleResult[], ip = new ArcjetIpDetails()) {
  return new ArcjetAllowDecision({ ttl: 0, results, reason: new ArcjetReason(), ip });
}

describe('classifyDecision', () => {
  it('reports a human when Arcjet finds no bot', () => {
    expect(classifyDecision(allowed([bot()]), CHROME)).toEqual({
      kind: 'caller',
      by: 'arcjet',
      botType: 'LIKELY_NOT_A_BOT',
      reason: 'Arcjet found no sign of a bot.',
    });
  });

  it('reports a bot that names itself as AUTOMATED, with the bots Arcjet identified', () => {
    const verdict = classifyDecision(allowed([bot({ denied: ['CURL'] })]), 'curl/8.11.1');
    expect(verdict).toMatchObject({ kind: 'caller', botType: 'AUTOMATED' });
    expect(verdict.reason).toContain('CURL');
  });

  it('reports a verified bot as VERIFIED_BOT', () => {
    const decision = allowed([bot({ denied: ['GOOGLE_CRAWLER'], verified: true })]);
    expect(classifyDecision(decision, 'Googlebot/2.1')).toMatchObject({ botType: 'VERIFIED_BOT' });
  });

  it.each(['HEADLESS_CHROME', 'JAVASCRIPT_PHANTOM', 'CYPRESS'])(
    'reports a script-driven browser (%s) as LIKELY_AUTOMATED',
    (id) => {
      const decision = allowed([bot({ denied: [id] })]);
      expect(classifyDecision(decision, CHROME)).toMatchObject({ botType: 'LIKELY_AUTOMATED' });
    },
  );

  it("reports a browser User-Agent from a hosting provider's network as LIKELY_AUTOMATED", () => {
    const decision = allowed([bot()], new ArcjetIpDetails({ isHosting: true }));
    expect(classifyDecision(decision, CHROME)).toMatchObject({ botType: 'LIKELY_AUTOMATED' });
  });

  it('reports a spoofed bot as NOT_ANALYZED, even when Arcjet also calls it verified', () => {
    const decision = allowed([bot({ denied: ['GOOGLE_CRAWLER'], spoofed: true, verified: true })]);
    const verdict = classifyDecision(decision, 'Googlebot/2.1');
    expect(verdict).toMatchObject({ botType: 'NOT_ANALYZED' });
    expect(verdict.reason).toContain('claims to be GOOGLE_CRAWLER');
  });

  it('reports a known botnet as NOT_ANALYZED', () => {
    const decision = allowed([bot({ denied: ['MIRAI_BOTNET'] })]);
    expect(classifyDecision(decision, 'x')).toMatchObject({ botType: 'NOT_ANALYZED' });
  });

  it('reports a request without a User-Agent as NOT_ANALYZED', () => {
    expect(classifyDecision(allowed([bot()]), undefined)).toMatchObject({
      by: 'arcjet',
      botType: 'NOT_ANALYZED',
    });
  });

  it('blocks a request Shield denied', () => {
    const shield = new ArcjetShieldReason({ shieldTriggered: true });
    const decision = new ArcjetDenyDecision({
      ttl: 0,
      results: [bot(), result(shield, 'DENY')],
      reason: shield,
      ip: new ArcjetIpDetails(),
    });
    expect(classifyDecision(decision, CHROME)).toEqual({
      kind: 'blocked',
      by: 'arcjet',
      reason: 'Arcjet Shield found an attack.',
    });
  });

  it('falls back to the User-Agent check, and says why, when Arcjet could not decide', () => {
    const decision = new ArcjetErrorDecision({
      ttl: 0,
      results: [],
      reason: new ArcjetErrorReason(new Error('invalid key')),
    });
    const verdict = classifyDecision(decision, 'curl/8.11.1');
    expect(verdict).toMatchObject({ kind: 'caller', by: 'user-agent', botType: 'AUTOMATED' });
    expect(verdict.reason).toMatch(/^Arcjet could not decide \(invalid key\)\. /);
  });

  it('falls back to the User-Agent check when the bot rule did not report', () => {
    const verdict = classifyDecision(allowed([]), CHROME);
    expect(verdict).toMatchObject({ by: 'user-agent', botType: 'LIKELY_NOT_A_BOT' });
    expect(verdict.reason).toContain('its bot rule did not run');
  });
});
