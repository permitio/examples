import { describe, expect, it } from 'vitest';
import { accountKeyFor, demoBalance, KEY_PATTERN } from '@/lib/accounts';

describe('accountKeyFor', () => {
  it('turns the whole email address into a tenant key', () => {
    expect(accountKeyFor('alice@mesaverde.example')).toBe('alice-mesaverde-example');
    expect(accountKeyFor('Mary.Jane+bank@Example.COM')).toBe('mary-jane-bank-example-com');
  });

  it('gives addresses that share the part before the @ different accounts', () => {
    expect(accountKeyFor('alice@one.example')).not.toBe(accountKeyFor('alice@two.example'));
  });

  it('always makes a valid Permit key', () => {
    for (const email of ['a@b.c', '_x_@y.z', 'ünï@cödé.example']) {
      expect(accountKeyFor(email)).toMatch(KEY_PATTERN);
    }
  });

  it('refuses an address with nothing to make a key from', () => {
    expect(() => accountKeyFor('@.')).toThrow('Cannot derive an account key');
  });
});

describe('demoBalance', () => {
  it('is the same for an account every time, with two decimals at most', () => {
    const balance = demoBalance('alice-mesaverde-example');
    expect(demoBalance('alice-mesaverde-example')).toBe(balance);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBeLessThan(1_000_000);
    expect(Math.round(balance * 100) / 100).toBe(balance);
  });
});
