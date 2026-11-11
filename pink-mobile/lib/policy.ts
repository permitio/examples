import type {
  ConditionSetCreate,
  ConditionSetRuleCreate,
  IPermitApi,
  ResourceAttributeCreate,
  ResourceCreate,
  RoleAssignmentCreate,
  RoleCreate,
  UserCreate,
} from 'permitio';
import { TENANT, accountKeyOf, MANAGER_KEY } from '#lib/model';

/**
 * The policy and the demo data that `pnpm seed` (the Compose `setup` service) writes to Permit. The
 * checks in `pages/api` and `scripts/check-policy.ts` rely on every key here.
 */

type ResourceInstanceCreate = Parameters<IPermitApi['resourceInstances']['create']>[0];
type RelationshipTupleCreate = Parameters<IPermitApi['relationshipTuples']['create']>[0];

/** `blocked` is the user attribute the `blocked_users` and `active_users` user sets test. */
export const userAttributes: ResourceAttributeCreate[] = [
  { key: 'blocked', type: 'bool', description: 'A blocked customer may view their plan only' },
];

/** In creation order: `plan` refers to `account` through its `parent` relation. */
export const resources: ResourceCreate[] = [
  {
    key: 'representatives',
    name: 'Representatives',
    actions: { list: { name: 'List' }, assign: { name: 'Assign' } },
  },
  {
    key: 'users',
    name: 'Users',
    actions: { list: { name: 'List' }, create: { name: 'Create' } },
  },
  {
    key: 'account',
    name: 'Account',
    actions: { manage: { name: 'Manage' }, view: { name: 'View' } },
    roles: {
      owner: { name: 'Owner', permissions: ['view', 'manage'] },
      editor: { name: 'Editor', permissions: ['view'] },
      member: { name: 'Member', permissions: ['view'] },
    },
  },
  {
    key: 'plan',
    name: 'Plan',
    actions: { change: { name: 'Change' }, view: { name: 'View' } },
    attributes: { owner: { type: 'string', description: 'The key of the user the plan is for' } },
    relations: { parent: 'account' },
    roles: {
      editor: {
        name: 'Editor',
        permissions: ['view', 'change'],
        // An editor on an account is an editor on the plan that account is the parent of.
        granted_to: {
          users_with_role: [
            { role: 'editor', on_resource: 'account', linked_by_relation: 'parent' },
          ],
        },
      },
    },
  },
];

/** Roles granted for the whole tenant. */
export const roles: RoleCreate[] = [
  {
    key: 'manager',
    name: 'Manager',
    permissions: [
      'representatives:list',
      'representatives:assign',
      'users:list',
      'users:create',
      'account:view',
      'plan:view',
    ],
  },
  { key: 'representative', name: 'Representative', permissions: ['users:list'] },
];

export const conditionSets: ConditionSetCreate[] = [
  {
    key: 'blocked_users',
    name: 'Blocked Users',
    type: 'userset',
    conditions: { allOf: [{ allOf: [{ 'user.blocked': { equals: true } }] }] },
  },
  {
    key: 'active_users',
    name: 'Active Users',
    type: 'userset',
    conditions: { allOf: [{ allOf: [{ 'user.blocked': { equals: false } }] }] },
  },
  {
    key: 'owned_plans',
    name: 'Owned Plans',
    type: 'resourceset',
    resource_id: 'plan',
    conditions: { allOf: [{ allOf: [{ 'resource.owner': { equals: { ref: 'user.key' } } }] }] },
  },
];

/** Active users may view and change the plans they own; blocked users may only view them. */
export const conditionSetRules: ConditionSetRuleCreate[] = [
  { user_set: 'active_users', resource_set: 'owned_plans', permission: 'plan:view' },
  { user_set: 'active_users', resource_set: 'owned_plans', permission: 'plan:change' },
  { user_set: 'blocked_users', resource_set: 'owned_plans', permission: 'plan:view' },
];

interface Customer {
  email: string;
  firstName: string;
  lastName: string;
  plan: 'VIP' | 'Standard';
  blocked: boolean;
}

const customers: Customer[] = [
  { email: 'harry@potter.io', firstName: 'Harry', lastName: 'Potter', plan: 'VIP', blocked: false },
  {
    email: 'hermione@granger.app',
    firstName: 'Hermione',
    lastName: 'Granger',
    plan: 'VIP',
    blocked: false,
  },
  {
    email: 'ron@weasley.me',
    firstName: 'Ron',
    lastName: 'Weasley',
    plan: 'Standard',
    blocked: true,
  },
];

const employees = [
  { email: MANAGER_KEY, firstName: 'Albus', lastName: 'Dumbledore' },
  { email: 'sirius@pink.mobile', firstName: 'Sirius', lastName: 'Black' },
  { email: 'luna@pink.mobile', firstName: 'Luna', lastName: 'Lovegood' },
];

function accountKey(email: string): string {
  const key = accountKeyOf(email);
  if (key === undefined) throw new Error(`${email} is not an email address`);
  return key;
}

export const users: UserCreate[] = [
  ...customers.map(({ email, firstName, lastName, plan, blocked }) => ({
    key: email,
    email,
    first_name: firstName,
    last_name: lastName,
    attributes: { plan, blocked },
  })),
  ...employees.map(({ email, firstName, lastName }) => ({
    key: email,
    email,
    first_name: firstName,
    last_name: lastName,
    attributes: {},
  })),
];

/** Every customer has an account and a plan, both keyed by the local part of their email. */
export const resourceInstances: ResourceInstanceCreate[] = customers.flatMap(({ email }) => [
  { resource: 'account', key: accountKey(email), tenant: TENANT },
  { resource: 'plan', key: accountKey(email), tenant: TENANT },
]);

/** Each account is the `parent` of the customer's plan. */
export const relationshipTuples: RelationshipTupleCreate[] = customers.map(({ email }) => ({
  subject: `account:${accountKey(email)}`,
  relation: 'parent',
  object: `plan:${accountKey(email)}`,
  tenant: TENANT,
}));

/**
 * The demo's starting assignments. Hermione owns no account: she is a member of Harry's, so a
 * representative may not open her account and she may not change her own plan.
 */
export const roleAssignments: RoleAssignmentCreate[] = [
  { user: 'harry@potter.io', role: 'owner', resource_instance: 'account:harry', tenant: TENANT },
  { user: 'ron@weasley.me', role: 'owner', resource_instance: 'account:ron', tenant: TENANT },
  {
    user: 'hermione@granger.app',
    role: 'member',
    resource_instance: 'account:harry',
    tenant: TENANT,
  },
  { user: MANAGER_KEY, role: 'manager', tenant: TENANT },
  { user: 'sirius@pink.mobile', role: 'representative', tenant: TENANT },
  { user: 'luna@pink.mobile', role: 'representative', tenant: TENANT },
  {
    user: 'sirius@pink.mobile',
    role: 'editor',
    resource_instance: 'account:harry',
    tenant: TENANT,
  },
  { user: 'luna@pink.mobile', role: 'editor', resource_instance: 'account:ron', tenant: TENANT },
];
