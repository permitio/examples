import { describe, expect, it } from 'vitest';
import { resourceParts, SIGN_LIMIT, type Sign, sharedResources, signsOf } from '@/components/panel/signs';
import type { CheckEvent, DemoEvent, ReadEvent, WriteEvent } from '@/types';

const check = (id: number, extra: Partial<CheckEvent> = {}): CheckEvent => ({
  id,
  kind: 'check',
  at: 1_000 + id,
  user: 'aragorn',
  action: 'view',
  resource: 'shipment:SHP-77001',
  tenant: 'shire-freight',
  allow: true,
  ms: 1.2,
  input: { user: { key: 'aragorn' } },
  source: 'action',
  ...extra,
});
const write = (id: number): WriteEvent => ({ id, kind: 'write', at: 1_000 + id, what: 'grant aragorn collaborator', ms: 40, ok: true });

/** The panel's feed holds its events newest first. */
const feed = (...events: DemoEvent[]) => [...events].sort((a, b) => b.id - a.id);

const answers = (signs: Sign[]) => signs.map((s) => [s.action, s.resource, s.answer.allow, s.answer.id]);

describe('signsOf: where the persona can go', () => {
  it('shows one sign per action and resource the persona was checked on, in first-seen order, with the newest answer', () => {
    const signs = signsOf(
      feed(
        check(1),
        check(2, { resource: 'shipment:SHP-77002', allow: false }),
        check(3, { action: 'view_profile', resource: 'organization:shire-freight' }),
        check(4, { allow: false }),
      ),
      'aragorn',
      0,
    );

    expect(answers(signs)).toEqual([
      ['view', 'shipment:SHP-77001', false, 4],
      ['view', 'shipment:SHP-77002', false, 2],
      ['view_profile', 'organization:shire-freight', true, 3],
    ]);
  });

  it("counts the persona's checks from every source, including background re-checks, and nobody else's", () => {
    const signs = signsOf(
      feed(
        check(1, { source: 'refresh' }),
        check(2, { source: 'guard', action: 'manage_members', resource: 'organization:riders-of-rohan' }),
        check(3, { user: 'eowyn', action: 'invite' }),
        write(4),
        check(5, { source: undefined, action: 'upload_docs' }),
        check(6, { action: 'request_renewal', allow: false, error: 'The PDP did not answer.' }),
      ),
      'aragorn',
      0,
    );

    expect(answers(signs)).toEqual([
      ['view', 'shipment:SHP-77001', true, 1],
      ['manage_members', 'organization:riders-of-rohan', true, 2],
      ['upload_docs', 'shipment:SHP-77001', true, 5],
      ['request_renewal', 'shipment:SHP-77001', false, 6],
    ]);
  });

  it('leaves out the checks a "Clear view" hid', () => {
    const signs = signsOf(feed(check(1, { action: 'upload_docs' }), check(2, { allow: false }), check(3)), 'aragorn', 2);

    expect(answers(signs)).toEqual([['view', 'shipment:SHP-77001', true, 3]]);
    expect(signs[0]?.previous).toBeUndefined();
  });

  it('has no previous answer while every check of the pair gave the same one', () => {
    const [sign] = signsOf(feed(check(1), check(2), check(3)), 'aragorn', 0);

    expect(sign?.answer).toEqual({ allow: true, id: 3, since: 1 });
    expect(sign?.previous).toBeUndefined();
  });

  it('keeps the answer from before a change, so the sign can turn over from it', () => {
    const [sign] = signsOf(feed(check(1), check(2), check(3, { allow: false })), 'aragorn', 0);

    expect(sign?.answer).toEqual({ allow: false, id: 3, since: 3 });
    expect(sign?.previous).toEqual({ allow: true, id: 2, since: 1 });
  });

  it('keeps both runs steady through re-checks that repeat the new answer, so the sign turns over once per change', () => {
    const [sign] = signsOf(feed(check(1), check(2, { allow: false }), check(3, { allow: false }), check(4, { allow: false })), 'aragorn', 0);

    expect(sign?.answer).toEqual({ allow: false, id: 4, since: 2 });
    expect(sign?.previous).toEqual({ allow: true, id: 1, since: 1 });
  });

  it('turns from the latest answer when the answer changes again', () => {
    const [sign] = signsOf(feed(check(1), check(2, { allow: false }), check(3)), 'aragorn', 0);

    expect(sign?.answer).toEqual({ allow: true, id: 3, since: 3 });
    expect(sign?.previous).toEqual({ allow: false, id: 2, since: 2 });
  });

  it(`shows at most ${SIGN_LIMIT} signs, the pairs checked most recently, still in first-seen order`, () => {
    const actions = Array.from({ length: SIGN_LIMIT + 2 }, (_, i) => `action_${i}`);
    const events = actions.map((action, i) => check(i + 1, { action }));
    // action_0 is checked again last, so it stays; action_1 and action_2 are the least recently checked.
    const signs = signsOf(feed(...events, check(actions.length + 1, { action: 'action_0' })), 'aragorn', 0);

    expect(SIGN_LIMIT).toBe(8);
    expect(signs.map((s) => s.action)).toEqual(['action_0', ...actions.slice(3)]);
  });

  it('gives each pair a distinct key', () => {
    const signs = signsOf(feed(check(1), check(2, { action: 'view_profile' }), check(3, { resource: 'shipment:SHP-77002' })), 'aragorn', 0);

    expect(new Set(signs.map((s) => s.key)).size).toBe(3);
  });

  it('shows no signs before the persona was checked', () => {
    expect(signsOf(feed(write(1), check(2, { user: 'frodo' })), 'aragorn', 0)).toEqual([]);
  });

  it("makes no sign of a user-permissions read: Merry's grid asks for a list, and no place was opened or closed by it", () => {
    const read: ReadEvent = {
      id: 1, kind: 'read', at: 1_001, user: 'merry', tenants: ['shire-freight'], ms: 3, source: 'action', entries: 9,
      request: { user: { key: 'merry', attributes: { current_time: 1_001 } }, tenants: ['shire-freight'] },
    };
    expect(signsOf(feed(read), 'merry', 0)).toEqual([]);
    // A check of Merry's after it still makes its sign: the read is skipped, not the persona.
    expect(answers(signsOf(feed(read, check(2, { user: 'merry' })), 'merry', 0))).toEqual([['view', 'shipment:SHP-77001', true, 2]]);
  });
});

describe('sharedResources', () => {
  it('names the resources more than one sign is about', () => {
    const signs = signsOf(
      feed(check(1), check(2, { action: 'upload_docs' }), check(3, { action: 'view_profile', resource: 'organization:shire-freight' })),
      'aragorn',
      0,
    );

    expect(sharedResources(signs)).toEqual(new Set(['shipment:SHP-77001']));
  });
});

describe('resourceParts', () => {
  it('splits a recorded resource into its type and key', () => {
    expect(resourceParts('shipment:SHP-77001')).toEqual({ type: 'shipment', key: 'SHP-77001' });
    expect(resourceParts('organization:riders-of-rohan-llc')).toEqual({ type: 'organization', key: 'riders-of-rohan-llc' });
  });

  it('splits at the first colon only, and keeps a resource without a type whole', () => {
    expect(resourceParts('document:SHP-77001:invoice')).toEqual({ type: 'document', key: 'SHP-77001:invoice' });
    expect(resourceParts('SHP-77001')).toEqual({ type: undefined, key: 'SHP-77001' });
  });
});
