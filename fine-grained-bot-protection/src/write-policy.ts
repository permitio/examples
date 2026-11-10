import type { ConditionSetCreate, ConditionSetRuleCreate, Permit } from 'permitio';
import { USER_KEY } from '#src/items';
import {
  BOT_TYPE_ATTRIBUTE,
  CONTENT_ITEM,
  GRANTS,
  RESOURCE_KEY,
  RESOURCE_SETS,
  type ResourceSetKey,
  USER_SETS,
  type UserSetKey,
} from '#src/policy';

type Api = Permit['api'];

/** The parts of the Permit SDK's API client the setup uses. Tests replace it. */
export interface PolicyApi {
  resources: Pick<Api['resources'], 'list' | 'create' | 'update'>;
  resourceAttributes: Pick<Api['resourceAttributes'], 'list' | 'create' | 'update'>;
  conditionSets: Pick<Api['conditionSets'], 'list' | 'create' | 'update'>;
  conditionSetRules: Pick<Api['conditionSetRules'], 'list' | 'create'>;
  users: Pick<Api['users'], 'sync'>;
}

type RuleFilter = Parameters<Api['conditionSetRules']['list']>[0];

/** Permit's built-in resource that holds the user attributes. */
const USER_RESOURCE = '__user';

/** A user set or resource set as setup writes it: every field it sends is filled in. */
export type SetPayload = ConditionSetCreate &
  Required<Pick<ConditionSetCreate, 'type' | 'description' | 'conditions'>>;

/** A user set: the caller's `botType` equals any of the set's bot types. */
export function userSetPayload(set: (typeof USER_SETS)[number]): SetPayload {
  const matches = set.botTypes.map((botType) => ({ 'user.botType': { equals: botType } }));
  return {
    key: set.key,
    name: set.name,
    description: set.description,
    type: 'userset',
    conditions: { allOf: [{ anyOf: matches }] },
  };
}

/**
 * A resource set: whether the caller owns the item (its `owner` is the caller's user key) and
 * whether the item is private.
 */
export function resourceSetPayload(set: (typeof RESOURCE_SETS)[number]): SetPayload {
  const owner = set.owner === 'caller' ? 'equals' : 'not-equals';
  return {
    key: set.key,
    name: set.name,
    description: set.name,
    type: 'resourceset',
    resource_id: RESOURCE_KEY,
    conditions: {
      allOf: [
        {
          allOf: [
            { 'resource.owner': { [owner]: { ref: 'user.key' } } },
            { 'resource.private': { equals: set.private } },
          ],
        },
      ],
    },
  };
}

/** One rule per user set, action and resource set that GRANTS allows. */
export function grantRules(): ConditionSetRuleCreate[] {
  return Object.entries(GRANTS).flatMap(([userSet, byResourceSet]) =>
    Object.entries(byResourceSet).flatMap(([resourceSet, actions]) =>
      actions.map((action) => ({
        user_set: userSet as UserSetKey,
        permission: `${RESOURCE_KEY}:${action}`,
        resource_set: resourceSet as ResourceSetKey,
      })),
    ),
  );
}

export type Log = (line: string) => void;

/** Runs one API call, labelling any error with what was being written. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(`${label}: ${describeError(err)}`, { cause: err });
  }
}

/** The error's message, with the status and body of a Permit API error. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const response = (err as { response?: { status?: unknown; data?: unknown } }).response;
  if (response === undefined) return err.message || err.name;
  const body = response.data === undefined ? '' : ` ${JSON.stringify(response.data).slice(0, 500)}`;
  return `${err.message || err.name} (HTTP ${String(response.status)})${body}`;
}

/**
 * Creates the policy and the demo user in a Permit environment, or brings them back to this
 * definition when they are there already, so it is safe to run again. It reads each list first
 * rather than relying on a 409 from a create, because the SDK logs every failed call as an error. A
 * grant that exists is not sent again: Permit answers 409 to a duplicate. The environment is meant
 * to be the example's own, so the first page of each list (100 entries) holds everything. Grants
 * nobody asked for are left alone.
 */
export async function writePolicy(api: PolicyApi, log: Log): Promise<void> {
  // Permit read: the resources (api.resources.list).
  const resources = await step('list resources', () => api.resources.list());
  const { key, ...resourceUpdate } = CONTENT_ITEM;
  if (resources.some((r) => r.key === key)) {
    // Permit write: the resource's actions and attributes (api.resources.update).
    await step(`update resource ${key}`, () => api.resources.update(key, resourceUpdate));
    log(`updated resource ${key}`);
  } else {
    // Permit write: a new resource (api.resources.create).
    await step(`create resource ${key}`, () => api.resources.create(CONTENT_ITEM));
    log(`created resource ${key}`);
  }

  const { key: attribute, ...attributeUpdate } = BOT_TYPE_ATTRIBUTE;
  // Permit read: the user attributes (api.resourceAttributes.list on __user).
  const attributes = await step('list user attributes', () =>
    api.resourceAttributes.list({ resourceKey: USER_RESOURCE }),
  );
  if (attributes.some((a) => a.key === attribute)) {
    // Permit write: the user attribute (api.resourceAttributes.update).
    await step(`update user attribute ${attribute}`, () =>
      api.resourceAttributes.update(USER_RESOURCE, attribute, attributeUpdate),
    );
    log(`updated user attribute ${attribute}`);
  } else {
    // Permit write: a new user attribute (api.resourceAttributes.create).
    await step(`create user attribute ${attribute}`, () =>
      api.resourceAttributes.create(USER_RESOURCE, BOT_TYPE_ATTRIBUTE),
    );
    log(`created user attribute ${attribute}`);
  }

  // Permit read: the user sets and resource sets (api.conditionSets.list).
  const existing = await step('list condition sets', () => api.conditionSets.list());
  const sets = [...USER_SETS.map(userSetPayload), ...RESOURCE_SETS.map(resourceSetPayload)];
  for (const set of sets) {
    const kind = set.type === 'userset' ? 'user set' : 'resource set';
    if (existing.some((s) => s.key === set.key)) {
      const { name, description, conditions } = set;
      // Permit write: the set's conditions (api.conditionSets.update).
      await step(`update ${kind} ${set.key}`, () =>
        api.conditionSets.update(set.key, { name, description, conditions }),
      );
      log(`updated ${kind} ${set.key}`);
    } else {
      // Permit write: a new set (api.conditionSets.create).
      await step(`create ${kind} ${set.key}`, () => api.conditionSets.create(set));
      log(`created ${kind} ${set.key}`);
    }
  }

  const granted = new Set<string>();
  for (const { key: userSet } of USER_SETS) {
    // The SDK's type asks for all three filters, but the API takes each on its own and the SDK
    // leaves out the ones that are undefined.
    const filter = { userSetKey: userSet } as RuleFilter;
    // Permit read: the user set's grants (api.conditionSetRules.list).
    const rules = await step(`list grants of ${userSet}`, () => api.conditionSetRules.list(filter));
    for (const r of rules) granted.add(ruleLabel(r));
  }
  for (const rule of grantRules()) {
    const label = ruleLabel(rule);
    if (granted.has(label)) {
      log(`already granted ${label}`);
      continue;
    }
    // Permit write: a grant (api.conditionSetRules.create).
    await step(`grant ${label}`, () => api.conditionSetRules.create(rule));
    log(`granted ${label}`);
  }

  // The resource sets compare an item's owner with the user's `key` attribute, which the PDP has
  // only for a user Permit knows. The botType still comes with each check.
  // Permit write: the demo user (api.users.sync), created or replaced.
  const { created } = await step(`sync user ${USER_KEY}`, () =>
    api.users.sync({ key: USER_KEY, email: USER_KEY }),
  );
  log(`${created ? 'created' : 'updated'} user ${USER_KEY}`);
}

function ruleLabel(rule: { user_set: string; permission: string; resource_set: string }): string {
  return `${rule.user_set} may ${rule.permission} on ${rule.resource_set}`;
}
