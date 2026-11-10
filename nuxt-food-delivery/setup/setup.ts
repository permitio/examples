// Creates this example's policy and demo data in a Permit environment through the API. Safe to
// re-run: a 409 on create means the object exists, and it is updated to match instead.
// Run: pnpm seed, or the setup service in docker-compose.yml. Needs PERMIT_API_KEY; PERMIT_API_URL
// defaults to https://api.permit.io.
import { pathToFileURL } from 'node:url';
import { Permit, PermitApiError } from 'permitio';
import { PERSONAS, SEED_MEALS } from '#shared/demo';
import {
  CONDITION_SET_RULES,
  CONDITION_SETS,
  ORDER_ROLES,
  RESOURCES,
  TENANT_ROLES,
  TENANTS,
  USER_ATTRIBUTES,
  USER_RESOURCE,
} from '#setup/policy';

/** The parts of the SDK client that setup uses, so tests can pass a fake. */
export type SetupClient = Pick<Permit, 'api'>;
export type Log = (line: string) => void;
type Outcome = 'created' | 'updated' | 'exists';

function statusOf(error: unknown): number | undefined {
  return error instanceof PermitApiError ? error.response?.status : undefined;
}

/** A failed setup step: names the object, keeps the API's explanation, and the SDK's error. */
export class SetupError extends Error {
  constructor(label: string, cause: unknown) {
    const detail = cause instanceof PermitApiError ? cause.response?.data : undefined;
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${label}: ${reason}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`, {
      cause,
    });
    this.name = 'SetupError';
  }
}

/** Creates an object; on a 409, updates it (or leaves it, when there is nothing to update). */
async function write(
  log: Log,
  label: string,
  create: () => Promise<unknown>,
  update?: () => Promise<unknown>,
): Promise<void> {
  let outcome: Outcome;
  try {
    await create();
    outcome = 'created';
  } catch (error) {
    if (statusOf(error) !== 409) throw new SetupError(label, error);
    try {
      if (update) await update();
    } catch (updateError) {
      throw new SetupError(label, updateError);
    }
    outcome = update ? 'updated' : 'exists';
  }
  log(`  ${outcome.padEnd(7)} ${label}`);
}

export async function runSetup(permit: SetupClient, log: Log): Promise<void> {
  const { api } = permit;

  log('Policy');
  for (const attribute of USER_ATTRIBUTES) {
    // Permit write: declares the user attribute the experienced-riders user set reads.
    await write(
      log,
      `user attribute ${attribute.key}`,
      () => api.resourceAttributes.create(USER_RESOURCE, attribute),
      () =>
        api.resourceAttributes.update(USER_RESOURCE, attribute.key, {
          type: attribute.type,
          description: attribute.description,
        }),
    );
  }
  for (const resource of RESOURCES) {
    // Permit write: declares the resource with its actions and attributes.
    await write(
      log,
      `resource ${resource.key}`,
      () => api.resources.create(resource),
      () =>
        api.resources.update(resource.key, {
          name: resource.name,
          actions: resource.actions,
          ...(resource.attributes === undefined ? {} : { attributes: resource.attributes }),
        }),
    );
  }
  for (const role of ORDER_ROLES) {
    // Permit write: the instance roles a user can hold on one order (ReBAC).
    await write(
      log,
      `resource role Order#${role.key}`,
      () => api.resourceRoles.create('Order', role),
      () =>
        api.resourceRoles.update('Order', role.key, {
          name: role.name,
          permissions: role.permissions ?? [],
        }),
    );
  }
  for (const role of TENANT_ROLES) {
    // Permit write: the tenant roles and the permissions each grants in its city (RBAC).
    await write(
      log,
      `role ${role.key}`,
      () => api.roles.create(role),
      () => api.roles.update(role.key, { name: role.name, permissions: role.permissions }),
    );
  }
  for (const tenant of TENANTS) {
    // Permit write: one tenant per city.
    await write(
      log,
      `tenant ${tenant.key}`,
      () => api.tenants.create(tenant),
      () => api.tenants.update(tenant.key, { name: tenant.name }),
    );
  }
  for (const set of CONDITION_SETS) {
    // Permit write: the ABAC user set and resource set.
    await write(
      log,
      `condition set ${set.key}`,
      () => api.conditionSets.create(set),
      () =>
        api.conditionSets.update(set.key, {
          name: set.name,
          ...(set.conditions === undefined ? {} : { conditions: set.conditions }),
        }),
    );
  }
  for (const rule of CONDITION_SET_RULES) {
    // Permit write: grants a user set (or a role) a permission on a resource set. The endpoint
    // skips a rule that already exists.
    await write(log, `rule ${rule.user_set} may ${rule.permission} on ${rule.resource_set}`, () =>
      api.conditionSetRules.create(rule),
    );
  }

  log('Demo users');
  for (const persona of PERSONAS) {
    const attributes =
      persona.numberOfRides === undefined ? {} : { number_of_rides: persona.numberOfRides };
    // Permit write: creates the user, or resets its attributes to the demo's (sync replaces).
    await write(log, `user ${persona.key}`, () => api.users.sync({ key: persona.key, attributes }));
    for (const { role, tenant } of persona.roles) {
      // Permit write: the user's role in one city.
      await write(log, `role ${role} for ${persona.key} in ${tenant}`, () =>
        api.roleAssignments.assign({ user: persona.key, role, tenant }),
      );
    }
  }

  log('Demo meals');
  for (const meal of SEED_MEALS) {
    // Permit write: registers the meal as a Meal instance in its city.
    await write(log, `meal ${meal.id} in ${meal.city}`, () =>
      api.resourceInstances.create({ key: meal.id, resource: 'Meal', tenant: meal.city }),
    );
  }
}

/**
 * The setup client: writes go straight to Permit's API. The SDK's own logging is off, because it
 * logs every 409 as an error, and a re-run is all 409s; failures are reported here instead.
 */
export function setupClient(env: NodeJS.ProcessEnv): Permit {
  const token = env['PERMIT_API_KEY'];
  if (!token) {
    throw new Error(
      'PERMIT_API_KEY is not set. Copy .env.example to .env and put your environment key in it.',
    );
  }
  const apiUrl = env['PERMIT_API_URL'] || 'https://api.permit.io';
  return new Permit({ token, apiUrl, log: { level: 'silent' } });
}

async function main(): Promise<void> {
  const permit = setupClient(process.env);
  const { apiUrl } = permit.config;
  console.log(`Setting up the food delivery policy in ${apiUrl}`);
  try {
    await runSetup(permit, (line) => console.log(line));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Check that ${apiUrl} is reachable and that PERMIT_API_KEY is an environment key there.`,
      { cause: error },
    );
  }
  console.log('Done.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
