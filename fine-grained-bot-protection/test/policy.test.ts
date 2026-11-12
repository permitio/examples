import { describe, expect, it } from 'vitest';
import { ITEMS, USER_KEY } from '#src/items';
import { PERSONAS } from '#src/personas';
import { BOT_TYPES, resourceSetFor, USER_SETS, userSetFor } from '#src/policy';
import { classifyUserAgent } from '#src/user-agent-classifier';

describe('userSetFor', () => {
  it('puts every bot type in exactly one user set', () => {
    for (const botType of BOT_TYPES) {
      const sets = USER_SETS.filter((s) => (s.botTypes as readonly string[]).includes(botType));
      expect(sets.map((s) => s.key)).toEqual([userSetFor(botType)]);
    }
  });

  it('counts verified bots as humans, as the blog post does', () => {
    expect(userSetFor('VERIFIED_BOT')).toBe('Human_Users');
  });
});

describe('resourceSetFor', () => {
  it('puts each demo item in its own resource set', () => {
    expect(ITEMS.map((item) => resourceSetFor(item, USER_KEY))).toEqual([
      'Public_Items',
      'Shared_Items',
      'Private_Items',
      'Blocked_Items',
    ]);
  });

  it('depends on who asks: the owner sees its private item as private, others as blocked', () => {
    const privateItem = { owner: 'someone@example.com', private: true };
    expect(resourceSetFor(privateItem, 'someone@example.com')).toBe('Private_Items');
    expect(resourceSetFor(privateItem, USER_KEY)).toBe('Blocked_Items');
  });
});

describe('the demo personas', () => {
  it('land in the four user sets, in order, without Arcjet', () => {
    const sets = PERSONAS.map((p) =>
      userSetFor(classifyUserAgent(p.userAgent ?? undefined).botType),
    );
    expect(sets).toEqual(['Human_Users', 'Trusted_Bots', 'Untrusted_Bots', 'Evil_Bots']);
  });
});
