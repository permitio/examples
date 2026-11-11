import { describe, expect, it } from 'vitest';
import { accountKeyOf, isPlan, otherPlan } from '#lib/model';
import { permitSettings } from '#lib/permit';

describe('accountKeyOf', () => {
  it('is the local part of an email address', () => {
    expect(accountKeyOf('harry@potter.io')).toBe('harry');
  });

  it.each(['harry', '@potter.io', 'harry@', 'a@b@c', 'account:harry@potter.io', 'h/x@potter.io'])(
    'rejects %j',
    (value) => {
      expect(accountKeyOf(value)).toBeUndefined();
    },
  );
});

describe('plans', () => {
  it('knows VIP and Standard only', () => {
    expect(isPlan('VIP') && isPlan('Standard')).toBe(true);
    expect(isPlan('vip') || isPlan(undefined)).toBe(false);
  });

  it('moves VIP down and everyone else up', () => {
    expect(otherPlan('VIP')).toBe('Standard');
    expect(otherPlan('Standard')).toBe('VIP');
    expect(otherPlan(null)).toBe('VIP');
  });
});

describe('permitSettings', () => {
  it('fails with the fix when the API key is missing or empty', () => {
    expect(() => permitSettings({})).toThrow(/PERMIT_API_KEY is not set\. Copy \.env\.example/);
    expect(() => permitSettings({ PERMIT_API_KEY: '' })).toThrow(/PERMIT_API_KEY/);
  });

  it('defaults to Permit cloud, a PDP on localhost and a silent SDK logger', () => {
    expect(permitSettings({ PERMIT_API_KEY: 'key' })).toEqual({
      token: 'key',
      apiUrl: 'https://api.permit.io',
      pdp: 'http://localhost:7766',
      logLevel: 'silent',
    });
  });

  it('takes a local Permit backend, the Compose PDP and a log level from the environment', () => {
    expect(
      permitSettings({
        PERMIT_API_KEY: 'key',
        PERMIT_API_URL: 'http://host.docker.internal:8000',
        PERMIT_PDP_URL: 'http://pdp:7000',
        PERMIT_LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      token: 'key',
      apiUrl: 'http://host.docker.internal:8000',
      pdp: 'http://pdp:7000',
      logLevel: 'debug',
    });
  });
});
