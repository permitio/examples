// The portal server: the enforcement point and the API the UI calls. Wires the real Permit SDK into the app.
import type { Permit } from 'permitio';
import { createApp, type Deps } from './app';
import { DemoClock } from './clock';
import { loadConfig } from './config';
import { EventLog } from './events';
import { MockClient } from './mock-client';
import { loadSeed } from './model';
import { createPermit } from './permit/client';
import { Enforcer } from './permit/enforcer';
import { PdpExplainer } from './permit/explainer';
import { confirmedWrites } from './permit/confirmed-writes';
import { FactsWriter } from './permit/facts-writer';
import { PdpSync } from './permit/pdp-sync';
import { ResourceFactsWriter } from './permit/resource-facts-writer';

type ConfirmedUsers = Pick<Deps['permitApi']['users'], 'get' | 'assignRole' | 'unassignRole'>;

/**
 * Permit's API in the shape `Deps` declares. The SDK satisfies it directly except for the role-assignment list, whose
 * `tenant` the SDK types as optional; when asked for one tenant's assignments, that tenant is every row's tenant.
 */
function permitApiOf(permit: Permit, writes: { users: ConfirmedUsers; resourceInstances: Deps['permitApi']['resourceInstances'] }): Deps['permitApi'] {
  // Permit SDK: the routes call api.tenants and api.roleAssignments directly, and api.users and
  // api.resourceInstances through `writes`, which return once the local PDP holds each change.
  const { tenants, roleAssignments, users } = permit.api;
  return {
    users: {
      get: (key) => writes.users.get(key),
      assignRole: (a) => writes.users.assignRole(a),
      unassignRole: (a) => writes.users.unassignRole(a),
      // Permit SDK: api.users.sync and api.users.delete pass straight through, unconfirmed. S5 syncs its connector and
      // then assigns it a role, whose confirmation also shows the PDP knows the user.
      sync: (u) => users.sync(u),
      delete: (key) => users.delete(key),
    },
    tenants,
    resourceInstances: writes.resourceInstances,
    roleAssignments: {
      async list(p) {
        const rows = await roleAssignments.list(p);
        return rows.flatMap((a) => {
          const tenant = a.tenant ?? p.tenant;
          if (tenant === undefined) return [];
          return [{ user: a.user, role: a.role, tenant, ...(a.resource_instance ? { resource_instance: a.resource_instance } : {}) }];
        });
      },
    },
  };
}

const config = loadConfig();
// fast (the default): writes go straight to the control plane, then PdpSync waits until the local PDP holds them.
// waited (PERMIT_WRITES=waited): writes go through the PDP, which answers once it has applied them.
const permit = createPermit(config.permit);
const writes = config.writes === 'fast' ? confirmedWrites(permit.api, new PdpSync(config.permit.pdpUrl, config.permit.apiKey)) : permit.api;
const events = new EventLog();
const clock = new DemoClock(config.demoClockEnabled);

const app = createApp({
  config,
  seed: loadSeed(),
  events,
  clock,
  // The Permit SDK instance is the enforcer's check client: every check, bulk check and filter goes through it.
  enforcer: new Enforcer(permit, clock, events),
  explainer: new PdpExplainer(config.permit.pdpUrl, config.permit.apiKey),
  facts: new FactsWriter(writes.users, events),
  resourceFacts: new ResourceFactsWriter(writes.resourceInstances, events),
  mock: new MockClient(config.greatEagleSystemsUrl),
  permitApi: permitApiOf(permit, writes),
});

app.listen(config.port, (error) => {
  if (error) throw error;
  console.log(`portal listening on :${config.port} (profile ${config.profile}, ${config.writes} writes)`);
});
