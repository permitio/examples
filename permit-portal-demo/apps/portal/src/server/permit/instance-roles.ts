import type { Deps } from '#src/server/app';
import { statusOf } from '#src/server/errors';
import { resumableWrite } from '#src/server/permit/writes';

/**
 * Runs one role write through {@link resumableWrite} and answers how long the PDP took to apply it,
 * or 0 when Permit said it was already done (`alreadyDone`): nothing changed, and the decision
 * panel shows it as "(already done)".
 */
async function resumable(
  d: Deps,
  what: string,
  alreadyDone: 404 | 409,
  write: () => Promise<unknown>,
): Promise<number> {
  let done = false;
  const ms = await resumableWrite(d.events, what, alreadyDone, async () => {
    try {
      await write();
    } catch (e) {
      done = statusOf(e) === alreadyDone;
      throw e;
    }
  });
  return done ? 0 : ms;
}

/**
 * Gives `user` the role `role` on one resource instance (`type:key`, in `tenant`): S2's grants,
 * S5's connector scope, S8's mapped roles. Returns once the PDP lists the role, with how long that
 * took. Permit answers a role the user holds already with success (measured on staging), so a
 * double click or a retry writes it again and the PDP confirms it again, and nothing changes; a
 * 409, should Permit ever answer one, is read as done and answers 0. Any other failure is a
 * WriteFailedError (424 when the PDP did not confirm the write in time).
 */
export function ensureInstanceRole(
  d: Deps,
  user: string,
  role: string,
  tenant: string,
  resourceInstance: string,
): Promise<number> {
  return resumable(d, `assign ${role} on ${resourceInstance} to ${user}`, 409, () =>
    // Permit write: the role on that one resource (api.users.assignRole with resource_instance),
    // confirmed on the PDP.
    d.permitApi.users.assignRole({ user, role, tenant, resource_instance: resourceInstance }),
  );
}

/**
 * Takes `role` on one resource instance away from `user`, like {@link ensureInstanceRole}: Permit's
 * 404 means it is already gone.
 */
export function ensureNoInstanceRole(
  d: Deps,
  user: string,
  role: string,
  tenant: string,
  resourceInstance: string,
): Promise<number> {
  return resumable(d, `unassign ${role} on ${resourceInstance} from ${user}`, 404, () =>
    // Permit write: the role on that one resource removed (api.users.unassignRole with
    // resource_instance), confirmed on the PDP.
    d.permitApi.users.unassignRole({ user, role, tenant, resource_instance: resourceInstance }),
  );
}
