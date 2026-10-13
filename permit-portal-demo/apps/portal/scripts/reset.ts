// Puts the demo back to its starting state, then runs preflight. Run: bin/demo reset <profile>
// The scenario runners call runReset() in-process before their first step.
import { loadSeed, RESOURCE, ROLE, TENANT } from '#src/server/model';
import {
  couldNotRun,
  describeError,
  ensureAssignment,
  HttpError,
  httpRequest,
  ignoreNotFound,
  type Log,
  logged,
  scriptPermit,
  syncUser,
  tenantExists,
  upsertInstance,
  upsertTenant,
} from '#scripts/lib/admin';
import { type ScriptEnv, scriptEnv } from '#scripts/lib/env';
import { ARAGORN, demoData, instance } from '#scripts/lib/fixtures';
import { isMain, type Outcome, runCli } from '#scripts/lib/report';
import { runPreflight } from '#scripts/preflight';
import { resetS2 } from '#scripts/reset/s2';
import { resetS5 } from '#scripts/reset/s5';
import { resetS8 } from '#scripts/reset/s8';

const EOMER = 'eomer';
const GRIMA = 'grima';

/**
 * Every portal /api route needs a seeded persona in `x-demo-persona` (any will do). 409 means the
 * demo clock is switched off, which is fine. The portal may be down during a policy-only reset, so
 * an unreachable portal is reported and skipped; any other answer (a 401 means the header is
 * missing) is a bug and fails the reset.
 */
async function resetPortalClock(env: ScriptEnv): Promise<string> {
  try {
    const res = await httpRequest('POST', `${env.portalUrl}/api/clock/reset`, {
      headers: { 'x-demo-persona': ARAGORN },
      accept: [409],
    });
    return res.status === 409 ? 'off' : 'done';
  } catch (err) {
    if (err instanceof HttpError)
      throw new Error(
        `the portal answered ${err.status} to POST /api/clock/reset with x-demo-persona ${ARAGORN}`,
      );
    if (!couldNotRun(err)) throw err;
    console.warn(
      `WARN: could not reset the portal's demo clock, the portal is not reachable at ${env.portalUrl} (${describeError(err)})`,
    );
    return 'skipped';
  }
}

export async function runReset(env: ScriptEnv = scriptEnv()): Promise<Outcome> {
  const log: Log = (line) => console.log(line);
  try {
    const permit = scriptPermit(env);
    const seed = loadSeed();
    console.log(`Resetting profile ${env.profile} (${env.apiUrl})`);

    const deleteTenant = (key: string) =>
      logged(log, `tenant ${key}`, async () => {
        if (!(await tenantExists(permit, key))) return 'absent';
        // Permit write: the tenant deleted, with everything in it (api.tenants.delete); a 404 means
        // it is gone already.
        return (await ignoreNotFound(() => permit.api.tenants.delete(key))) === 'done'
          ? 'deleted'
          : 'absent';
      });

    // 1. S1 creates riders-of-rohan live, so it must not exist at the start.
    await deleteTenant(TENANT.rohan);

    // 2. The impostor's pending organization, recreated from scratch so no role from a previous run
    //    survives.
    const llc = seed.organizations.find((o) => o.key === TENANT.rohanLlc);
    if (!llc) throw new Error(`demo-data/seed.json has no organization ${TENANT.rohanLlc}`);
    await deleteTenant(llc.key);
    await logged(log, `tenant ${llc.key}`, () =>
      upsertTenant(permit, { key: llc.key, name: llc.name }),
    );
    await logged(log, `instance ${RESOURCE.organization}:${llc.key}`, () =>
      upsertInstance(
        permit,
        instance(RESOURCE.organization, llc.key, llc.key, {
          ownership_verified: llc.ownership_verified,
        }),
      ),
    );
    await logged(log, `role ${ROLE.pendingMember} for ${GRIMA} on ${llc.key}`, () =>
      ensureAssignment(permit, { user: GRIMA, role: ROLE.pendingMember, tenant: llc.key }),
    );

    // 3. Every persona's attributes as in seed.json (Aragorn with no grants), and Éomer with no
    //    role anywhere.
    for (const user of demoData(seed).users)
      await logged(log, `user ${user.key}`, () => syncUser(permit, user));
    // Permit read: every role Éomer holds, in any tenant (api.roleAssignments.list).
    for (const a of await permit.api.roleAssignments.list({ user: EOMER })) {
      if (!a.tenant)
        throw new Error(`${EOMER}'s role ${a.role} has no tenant, so it cannot be unassigned`);
      const tenant = a.tenant;
      await logged(
        log,
        `role ${a.role} for ${EOMER} on ${a.resource_instance ?? tenant} removed`,
        () =>
          ignoreNotFound(() =>
            // Permit write: the role taken off Éomer (api.roleAssignments.unassign); a 404 means it
            // is gone already.
            permit.api.roleAssignments.unassign({
              user: EOMER,
              role: a.role,
              tenant,
              ...(a.resource_instance ? { resource_instance: a.resource_instance } : {}),
            }),
          ),
      );
    }

    // 4. What S2, S5 and S8 changed in Permit, each undone by its own hook (scripts/reset/), in run
    //    order.
    for (const resetScenario of [resetS2, resetS5, resetS8]) await resetScenario(permit, log);

    // 5. The mock: facts, organizations and requests back to seed state (Gríma's request pending
    //    again), and S5's connectors and shipments and S8's legacy app back to their start.
    await logged(log, 'Great Eagle systems mock reset', async () => {
      await httpRequest('POST', `${env.greatEagleSystemsUrl}/api/admin/reset`);
      return 'done';
    });

    // 6. The portal's demo clock back to zero.
    await logged(log, 'portal demo clock reset', () => resetPortalClock(env));

    // 7. Prove it: the preflight matrix and the starting-state check.
    const { outcome, summary } = await runPreflight(env);
    console.log(summary);
    return outcome;
  } catch (err) {
    console.error(`Reset stopped: ${describeError(err)}`);
    return couldNotRun(err) ? 'could-not-run' : 'fail';
  }
}

if (isMain(import.meta.url)) {
  await runCli(async () => {
    const env = scriptEnv();
    const outcome = await runReset(env);
    return {
      outcome,
      summary:
        outcome === 'pass'
          ? `reset ${env.profile}`
          : `reset ${env.profile} did not finish cleanly; see above`,
    };
  });
}
