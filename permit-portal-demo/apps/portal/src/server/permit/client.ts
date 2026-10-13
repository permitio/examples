import { Permit } from 'permitio';
import type { PermitSettings } from '#src/server/config';

export function createPermit(s: PermitSettings): Permit {
  // Permit SDK: the one Permit client the portal creates. `token` is the environment's API key, `pdp` is the local
  // PDP that answers every check, and `apiUrl` is Permit's API, which stores tenants, roles and attributes. With
  // proxyFactsViaPdp (PERMIT_WRITES=waited), writes go through the PDP and return once it has applied them.
  return new Permit({
    token: s.apiKey, apiUrl: s.apiUrl, pdp: s.pdpUrl,
    proxyFactsViaPdp: s.proxyFacts,
    factsSyncTimeout: s.proxyFacts ? 5 : null,
    factsSyncTimeoutPolicy: s.proxyFacts ? 'fail' : null,
    log: { level: 'warn' },
  });
}
