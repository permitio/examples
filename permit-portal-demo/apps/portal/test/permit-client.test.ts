import { describe, expect, it } from 'vitest';
import { createPermit } from '#src/server/permit/client';

const settings = {
  apiUrl: 'https://api.permit.io',
  apiKey: 'test-api-key',
  pdpUrl: 'http://pdp:7000',
};

describe('createPermit', () => {
  it('routes fact writes through the PDP and fails them after 5 s without confirmation', () => {
    expect(createPermit({ ...settings, proxyFacts: true }).config).toMatchObject({
      token: 'test-api-key',
      apiUrl: 'https://api.permit.io',
      pdp: 'http://pdp:7000',
      proxyFactsViaPdp: true,
      factsSyncTimeout: 5,
      factsSyncTimeoutPolicy: 'fail',
      log: { level: 'warn' },
    });
  });

  it('writes facts to the API without a sync wait when not proxied', () => {
    expect(createPermit({ ...settings, proxyFacts: false }).config).toMatchObject({
      proxyFactsViaPdp: false,
      factsSyncTimeout: null,
      factsSyncTimeoutPolicy: null,
    });
  });
});
