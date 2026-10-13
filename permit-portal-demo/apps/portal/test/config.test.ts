import { describe, expect, it } from 'vitest';
import { loadConfig } from '#src/server/config';

const required = {
  PERMIT_API_URL: 'https://api.permit.io',
  PERMIT_API_KEY: 'test-api-key',
  PROFILE: 'staging',
};

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('names PERMIT_API_URL when nothing is set', () => {
    expect(() => loadConfig({})).toThrow(/PERMIT_API_URL/);
  });

  it('fills every optional setting with its default', () => {
    expect(loadConfig(required)).toEqual({
      profile: 'staging',
      port: 3000,
      permit: {
        apiUrl: 'https://api.permit.io',
        apiKey: 'test-api-key',
        pdpUrl: 'http://localhost:7766',
        proxyFacts: false,
      },
      writes: 'fast',
      greatEagleSystemsUrl: 'http://localhost:4100',
      demoClockEnabled: false,
      grantDemoDurationMs: 120000,
      permitAppUrl: 'https://app.permit.io',
    });
  });

  it('prefers the values Compose sets over the defaults', () => {
    const env = {
      ...required,
      PORT: '3100',
      PERMIT_PDP_URL: 'http://pdp:7000',
      GREAT_EAGLE_SYSTEMS_URL: 'http://great-eagle-systems:4100',
      DEMO_CLOCK_ENABLED: 'True',
      GRANT_DEMO_DURATION_MS: '10000',
      PERMIT_APP_URL: 'https://app.example.test',
    };
    expect(loadConfig(env)).toEqual({
      profile: 'staging',
      port: 3100,
      permit: {
        apiUrl: 'https://api.permit.io',
        apiKey: 'test-api-key',
        pdpUrl: 'http://pdp:7000',
        proxyFacts: false,
      },
      writes: 'fast',
      greatEagleSystemsUrl: 'http://great-eagle-systems:4100',
      demoClockEnabled: true,
      grantDemoDurationMs: 10000,
      permitAppUrl: 'https://app.example.test',
    });
  });

  const sentinels: Record<string, string> = {
    PERMIT_API_URL: 'https://sentinel-api.example.test',
    PERMIT_API_KEY: 'sentinel-api-key-7f3a9c',
    PROFILE: 'sentinel-profile',
    PORT: '4321',
    PERMIT_PDP_URL: 'http://sentinel-pdp:7000',
    GREAT_EAGLE_SYSTEMS_URL: 'http://sentinel-systems:4100',
    DEMO_CLOCK_ENABLED: 'false',
    GRANT_DEMO_DURATION_MS: '98765',
    PERMIT_APP_URL: 'https://sentinel-app.example.test',
  };

  it.each<[string, string | undefined]>([
    ['PERMIT_API_URL', undefined],
    ['PERMIT_API_KEY', undefined],
    ['PROFILE', undefined],
    ['PERMIT_API_KEY', ''],
  ])('names a missing %s (value %j) without echoing any value from the env', (name, value) => {
    const env = { ...sentinels, [name]: value };
    const message = messageOf(() => loadConfig(env));
    expect(message).toContain(`Missing ${name}`);
    for (const envValue of Object.values(env)) {
      if (envValue) expect(message).not.toContain(envValue);
    }
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['GRANT_DEMO_DURATION_MS', '2m'],
    ['DEMO_CLOCK_ENABLED', 'yes'],
  ])('rejects %s=%s instead of running with a nonsense value', (name, value) => {
    expect(() => loadConfig({ ...required, [name]: value })).toThrow(`Invalid ${name}`);
  });
});
