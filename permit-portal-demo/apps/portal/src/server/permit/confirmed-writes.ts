import type { IResource, Permit } from 'permitio';
import { statusOf } from '#src/server/errors';
import { holds, type PdpSync, rolesIn } from '#src/server/permit/pdp-sync';

/** User attributes are global, so their probe can name any tenant; every environment has `default`. */
const ATTRIBUTE_PROBE: IResource = { type: 'organization', key: 'pdp-sync', tenant: 'default' };
/** A probe in one tenant, where the PDP lists the user's roles in that tenant. */
const roleProbe = (tenant: string): IResource => ({
  type: 'organization',
  key: 'pdp-sync',
  tenant,
});
/** A resource probe needs no real user. */
const RESOURCE_PROBE_USER = 'pdp-sync';

type Api = Permit['api'];
type RoleWrite = { user: string; role: string; tenant: string; resource_instance?: string };

/**
 * Permit's write calls the portal uses, each sent straight to the control plane and then confirmed
 * on the local PDP with {@link PdpSync}: it returns once the PDP holds the change, or fails with a
 * 424 like a waited write. Reads pass through. A role assign that Permit answers 409 (already
 * assigned), or an unassign it answers 404, is confirmed too before the error goes on, so a retried
 * step does not move on while the PDP is still behind.
 */
export function confirmedWrites(api: Api, sync: PdpSync) {
  const confirmRole = (a: RoleWrite, present: boolean) =>
    a.resource_instance === undefined
      ? sync.until(a.user, roleProbe(a.tenant), (v) => rolesIn(v).includes(a.role) === present)
      : // A role on a single instance is not in the tenant's role list: the PDP's
        // user-permissions answer lists the user's roles on that instance instead.
        sync.untilInstanceRole(a.user, a.tenant, a.resource_instance, a.role, present);

  const writeRole = async (
    write: () => Promise<unknown>,
    a: RoleWrite,
    present: boolean,
    alreadyDone: 404 | 409,
  ): Promise<unknown> => {
    try {
      const result = await write();
      await confirmRole(a, present);
      return result;
    } catch (e) {
      if (statusOf(e) === alreadyDone) await confirmRole(a, present);
      throw e;
    }
  };

  return {
    users: {
      get: (key: string) => api.users.get(key),
      // Permit SDK: api.users.update, then wait until the PDP's view of the user shows the new
      // attributes.
      async update(key: string, data: { attributes: object }) {
        const result = await api.users.update(key, data);
        await sync.until(key, ATTRIBUTE_PROBE, (v) => holds(v.user, data.attributes));
        return result;
      },
      // Permit SDK: api.users.assignRole and unassignRole, then wait until the PDP lists (or stops
      // listing) the role, in the tenant or on the one resource instance the write names.
      assignRole: (a: {
        user: string;
        role: string;
        tenant?: string;
        resource_instance?: string;
      }) => {
        if (a.tenant === undefined) return api.users.assignRole(a);
        const write: RoleWrite = { ...a, tenant: a.tenant };
        return writeRole(() => api.users.assignRole(a), write, true, 409);
      },
      unassignRole: (a: RoleWrite) => writeRole(() => api.users.unassignRole(a), a, false, 404),
    },
    resourceInstances: {
      get: (key: string) => api.resourceInstances.get(key),
      list: (p: { tenant?: string; resource?: string }) => api.resourceInstances.list(p),
      // Permit SDK: api.resourceInstances.create and update, then wait until the PDP's view of the
      // instance shows them.
      async create(i: { key: string; resource: string; tenant: string; attributes?: object }) {
        const result = await api.resourceInstances.create(i);
        await sync.until(
          RESOURCE_PROBE_USER,
          { type: i.resource, key: i.key, tenant: i.tenant },
          (v) => holds(v.resource, i.attributes ?? {}),
        );
        return result;
      },
      async update(instanceKey: string, data: { attributes: object }) {
        const result = await api.resourceInstances.update(instanceKey, data);
        const [type = '', key = ''] = instanceKey.split(':');
        await sync.until(RESOURCE_PROBE_USER, { type, key, tenant: result.tenant }, (v) =>
          holds(v.resource, data.attributes),
        );
        return result;
      },
    },
  };
}
