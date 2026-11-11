// The policy the setup script writes to Permit: the model the Permit docs walk through for this app
// (RBAC, then ABAC, then ReBAC), as data.
import type {
  ConditionSetCreate,
  ConditionSetRuleCreate,
  Permit,
  ResourceCreate,
  RoleCreate,
  TenantCreate,
} from 'permitio';
import { EXPERIENCED_RIDER_RIDES, FREE_DELIVERY_FROM, type Role } from '#shared/types';

/** permitio does not export this one by name. */
type ResourceRoleCreate = Parameters<Permit['api']['resourceRoles']['create']>[1];

const MEAL_ACTIONS = ['create', 'read', 'update', 'delete'] as const;
const ORDER_ACTIONS = [
  'create',
  'read',
  'fulfill',
  'assign-rider',
  'deliver',
  'create-with-free-delivery',
] as const;

type OrderAction = (typeof ORDER_ACTIONS)[number];
type MealAction = (typeof MEAL_ACTIONS)[number];
type Permission = `Meal:${MealAction}` | `Order:${OrderAction}`;

const actions = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, {}]));

export const RESOURCES: readonly ResourceCreate[] = [
  { key: 'Meal', name: 'Meal', actions: actions(MEAL_ACTIONS) },
  {
    key: 'Order',
    name: 'Order',
    actions: actions(ORDER_ACTIONS),
    attributes: { cost: { type: 'number', description: 'The order total before delivery' } },
  },
];

/** User attributes live on Permit's built-in `__user` resource. */
export const USER_RESOURCE = '__user';
export const USER_ATTRIBUTES = [
  { key: 'number_of_rides', type: 'number', description: 'Deliveries the rider has made' },
] as const;

export const TENANTS: readonly TenantCreate[] = [
  { key: 'california', name: 'California' },
  { key: 'washington', name: 'Washington' },
];

/**
 * Tenant roles (RBAC). Vendors and riders get no `fulfill` or `deliver` here: a tenant role applies
 * to every order in the city, and those two actions belong to the order's own vendor and rider (the
 * instance roles below).
 */
export const TENANT_ROLES: ReadonlyArray<RoleCreate & { key: Role; permissions: Permission[] }> = [
  {
    key: 'customer',
    name: 'Customer',
    permissions: ['Meal:read', 'Order:read', 'Order:create'],
  },
  {
    key: 'vendor',
    name: 'Vendor',
    permissions: ['Meal:read', 'Meal:create', 'Meal:update', 'Meal:delete', 'Order:read'],
  },
  { key: 'rider', name: 'Rider', permissions: ['Meal:read', 'Order:read'] },
  {
    key: 'admin',
    name: 'Admin',
    permissions: [
      'Meal:read',
      'Meal:create',
      'Meal:update',
      'Meal:delete',
      'Order:read',
      'Order:create',
      'Order:fulfill',
      'Order:assign-rider',
      'Order:deliver',
    ],
  },
];

/**
 * Instance roles on an order (ReBAC). The app gives the order's vendor `Order#Vendor` when the
 * order is placed, and the rider `Order#Rider` when an admin assigns them.
 */
export const ORDER_ROLES: readonly ResourceRoleCreate[] = [
  { key: 'Vendor', name: 'Vendor', permissions: ['fulfill', 'read'] },
  { key: 'Rider', name: 'Rider', permissions: ['deliver', 'read'] },
];

/** Condition sets (ABAC): orders from the free-delivery cost, and riders with enough rides. */
export const CONDITION_SETS: readonly ConditionSetCreate[] = [
  {
    key: 'orders_above_500',
    name: `Orders of ${FREE_DELIVERY_FROM} or more`,
    type: 'resourceset',
    resource_id: 'Order',
    conditions: {
      allOf: [{ allOf: [{ 'resource.cost': { 'greater-than-equals': FREE_DELIVERY_FROM } }] }],
    },
  },
  {
    key: 'experienced_riders',
    name: `Riders with ${EXPERIENCED_RIDER_RIDES} or more rides`,
    type: 'userset',
    conditions: {
      allOf: [
        {
          allOf: [{ 'user.number_of_rides': { 'greater-than-equals': EXPERIENCED_RIDER_RIDES } }],
        },
      ],
    },
  },
];

/**
 * ABAC rules. `is_role` grants a tenant role's permission on a resource set, as the Policy Editor
 * does when you tick a role's box under a resource set.
 */
export const CONDITION_SET_RULES: readonly ConditionSetRuleCreate[] = [
  {
    user_set: 'customer',
    is_role: true,
    permission: 'Order:create-with-free-delivery',
    resource_set: 'orders_above_500',
  },
  {
    user_set: 'admin',
    is_role: true,
    permission: 'Order:create-with-free-delivery',
    resource_set: 'orders_above_500',
  },
  {
    user_set: 'experienced_riders',
    permission: 'Order:deliver',
    resource_set: 'orders_above_500',
  },
];
