import { ApiKeyLevel, PermitApiError, type ResourceAttributeCreate } from 'permitio';
import { TENANT } from '#lib/model';
import { permit, permitSettings } from '#lib/permit';
import {
  conditionSetRules,
  conditionSets,
  relationshipTuples,
  resourceInstances,
  resources,
  roleAssignments,
  roles,
  userAttributes,
  users,
} from '#lib/policy';

/**
 * Writes the policy and the demo data in `lib/policy.ts` to the Permit environment of
 * `PERMIT_API_KEY`. Safe to re-run: what exists is updated to match, and the demo users' role
 * assignments and attributes go back to their starting state.
 */

type Log = (line: string) => void;

/** Runs one Permit call, and names it in the error when it fails. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`Could not ${label}`, { cause: error });
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof PermitApiError && error.response?.status === 409;
}

/**
 * Creates the object. When Permit answers 409 because it already exists, runs `update` if there is
 * one, and otherwise keeps the object as it is.
 */
async function createOrUpdate(
  label: string,
  create: () => Promise<unknown>,
  update: (() => Promise<unknown>) | undefined,
  log: Log,
): Promise<void> {
  try {
    await create();
    log(`created ${label}`);
    return;
  } catch (error) {
    if (!isConflict(error)) throw new Error(`Could not create ${label}`, { cause: error });
  }
  if (update === undefined) {
    log(`kept ${label}`);
    return;
  }
  await attempt(`update ${label}`, update);
  log(`updated ${label}`);
}

/**
 * Writes a fact that may exist already. Permit answers 200 or 409 for an existing role assignment
 * or tuple, depending on the version, so both mean the fact is there.
 */
async function ensure(label: string, write: () => Promise<unknown>, log: Log): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (!isConflict(error)) throw new Error(`Could not write ${label}`, { cause: error });
  }
  log(`ensured ${label}`);
}

/** The SDK has no user-attribute API, so this one call goes to the REST API directly. */
async function createUserAttribute(attribute: ResourceAttributeCreate, log: Log): Promise<void> {
  const { apiUrl, token } = permitSettings();
  const scope = `read the API key's environment from ${apiUrl}`;
  await attempt(`${scope} (are PERMIT_API_URL and the key right?)`, () =>
    permit().api.ensureAccessLevel(ApiKeyLevel.ENVIRONMENT_LEVEL_API_KEY),
  );
  const { projId, envId } = permit().config.apiContext.environmentContext;
  const response = await attempt(`create user attribute ${attribute.key}`, () =>
    fetch(`${apiUrl}/v2/schema/${projId}/${envId}/users/attributes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(attribute),
    }),
  );
  if (response.status === 409) {
    log(`kept user attribute ${attribute.key}`);
    return;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Could not create user attribute ${attribute.key}: ${response.status} ${body}`);
  }
  log(`created user attribute ${attribute.key}`);
}

const assignmentId = (a: { user: string; role: string; resource_instance?: string | null }) =>
  `${a.user} ${a.role} ${a.resource_instance ?? ''}`;

/** Removes the demo users' role assignments that are not in the starting state. */
async function resetRoleAssignments(log: Log): Promise<void> {
  const api = permit().api;
  const wanted = new Set(roleAssignments.map(assignmentId));
  const current = await Promise.all(
    users.map(({ key }) =>
      attempt(`list the role assignments of ${key}`, () =>
        api.roleAssignments.list({ user: key, tenant: TENANT, perPage: 100 }),
      ),
    ),
  );
  const extra = current.flat().filter((assignment) => !wanted.has(assignmentId(assignment)));
  for (const { user, role, resource_instance } of extra) {
    const scope = resource_instance ?? TENANT;
    await attempt(`unassign ${role} on ${scope} from ${user}`, () =>
      api.roleAssignments.unassign({
        user,
        role,
        tenant: TENANT,
        ...(resource_instance ? { resource_instance } : {}),
      }),
    );
    log(`unassigned ${role} on ${scope} from ${user}`);
  }
}

export async function runSetup(log: Log): Promise<void> {
  const api = permit().api;

  for (const attribute of userAttributes) await createUserAttribute(attribute, log);

  // One at a time, in order: a resource's roles and relations refer to the resources before it.
  for (const { key, ...resource } of resources) {
    await createOrUpdate(
      `resource ${key}`,
      () => api.resources.create({ key, ...resource }),
      () => api.resources.update(key, resource),
      log,
    );
  }

  // An update replaces the role's permissions and the set's conditions with the ones here.
  await Promise.all(
    roles.map((role) =>
      createOrUpdate(
        `role ${role.key}`,
        () => api.roles.create(role),
        () => api.roles.update(role.key, { name: role.name, permissions: role.permissions ?? [] }),
        log,
      ),
    ),
  );
  await Promise.all(
    conditionSets.map((set) =>
      createOrUpdate(
        `condition set ${set.key}`,
        () => api.conditionSets.create(set),
        () =>
          api.conditionSets.update(set.key, { name: set.name, conditions: set.conditions ?? {} }),
        log,
      ),
    ),
  );
  await Promise.all(
    conditionSetRules.map((rule) =>
      createOrUpdate(
        `rule ${rule.user_set} ${rule.permission} ${rule.resource_set}`,
        () => api.conditionSetRules.create(rule),
        undefined,
        log,
      ),
    ),
  );

  // sync replaces each user's attributes, so plans and `blocked` go back to the seed values.
  await Promise.all(
    users.map(async (user) => {
      await attempt(`sync user ${user.key}`, () => api.users.sync(user));
      log(`synced user ${user.key}`);
    }),
  );
  await Promise.all(
    resourceInstances.map((instance) =>
      createOrUpdate(
        `${instance.resource}:${instance.key}`,
        () => api.resourceInstances.create(instance),
        undefined,
        log,
      ),
    ),
  );

  await resetRoleAssignments(log);

  // One at a time: Permit can answer 409 to concurrent writes that touch the same user or
  // instance, without writing anything. Sequential, a 409 means the fact already exists.
  for (const assignment of roleAssignments) {
    const scope = assignment.resource_instance ?? TENANT;
    await ensure(
      `role ${assignment.role} on ${scope} for ${assignment.user}`,
      () => api.roleAssignments.assign(assignment),
      log,
    );
  }
  for (const tuple of relationshipTuples) {
    await ensure(
      `tuple ${tuple.subject} ${tuple.relation} ${tuple.object}`,
      () => api.relationshipTuples.create(tuple),
      log,
    );
  }
}
