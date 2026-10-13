import type { ResourceCreate, RoleCreate, ResourceRoleCreate, ConditionSetCreate } from 'permitio';

export const USER_ATTRIBUTES = [
  { key: 'identity_verified', type: 'bool' },
  { key: 'duplicate_check', type: 'string' },
  { key: 'risk_state', type: 'string' },
  { key: 'time_based_grants', type: 'object_array' },
  { key: 'current_time', type: 'number' },
  // S5's connector is a user of its own: what it is, which developer registered it and which
  // customer it acts for.
  { key: 'principal_type', type: 'string' },
  { key: 'owner', type: 'string' },
  { key: 'customer', type: 'string' },
] as const;

export const RESOURCES: ResourceCreate[] = [
  {
    key: 'organization',
    name: 'Organization',
    actions: {
      view_profile: {},
      view_own_request: {},
      cancel_request: {},
      manage_members: {},
      invite: {},
      transfer_admin: {},
      request_ean_association: {},
      register_integration: {},
    },
    attributes: { id: { type: 'string' }, ownership_verified: { type: 'bool' } },
  },
  // A grant is itself a permission: grant_<role> on the resource the role would be given on.
  {
    key: 'ean',
    name: 'EAN',
    actions: {
      view: {},
      ship: {},
      view_billing: {},
      manage_access: {},
      grant_shipper: {},
      grant_account_admin: {},
      create_shipment: {},
      approve_integration: {},
    },
    attributes: { id: { type: 'string' }, association_verified: { type: 'bool' } },
  },
  {
    key: 'account',
    name: 'Child account',
    actions: { view: {}, ship: {}, view_billing: {}, grant_account_manager: {} },
    attributes: { id: { type: 'string' } },
  },
  {
    key: 'location',
    name: 'Location',
    actions: { view: {}, operate: {}, grant_location_operator: {} },
    attributes: { id: { type: 'string' } },
  },
  {
    key: 'shipment',
    name: 'Shipment',
    actions: {
      view: {},
      upload_docs: {},
      comment: {},
      invite_collaborator: {},
      approve_collaborator: {},
      revoke_collaborator: {},
      request_renewal: {},
      approve_renewal: {},
    },
    attributes: { id: { type: 'string' }, requested_days: { type: 'number' } },
  },
  {
    key: 'onboarding_queue',
    name: 'Onboarding queue',
    actions: { review: {} },
    attributes: { id: { type: 'string' } },
  },
];

/**
 * The ReBAC links, each declared on the child: an EAN is the parent of its shipments and child
 * accounts, an account of its locations.
 */
export const RELATIONS = [
  {
    resource: 'shipment',
    relation: { key: 'parent', name: 'Parent EAN', subject_resource: 'ean' },
  },
  { resource: 'account', relation: { key: 'parent', name: 'Parent EAN', subject_resource: 'ean' } },
  {
    resource: 'location',
    relation: { key: 'parent', name: 'Parent account', subject_resource: 'account' },
  },
] as const;

export const TENANT_ROLES: Array<RoleCreate & { permissions: string[] }> = [
  {
    key: 'pending_member',
    name: 'Pending member',
    permissions: ['organization:view_own_request', 'organization:cancel_request'],
  },
  { key: 'org_member', name: 'Organization member', permissions: ['organization:view_profile'] },
  { key: 'org_admin', name: 'Organization admin', permissions: ['organization:view_profile'] },
  {
    key: 'onboarding_reviewer',
    name: 'Onboarding reviewer',
    permissions: ['onboarding_queue:review'],
  },
  { key: 'developer', name: 'Developer', permissions: ['organization:register_integration'] },
];

/**
 * Roles on a single resource, in seed order: a derived role comes after the role it derives from,
 * since Permit refuses a derivation from a role it does not have yet. Every right here is RBAC or
 * ReBAC.
 */
export const RESOURCE_ROLES: Array<{ resource: string; role: ResourceRoleCreate }> = [
  {
    resource: 'ean',
    role: {
      key: 'account_admin',
      name: 'Account admin',
      permissions: ['view', 'ship', 'view_billing', 'manage_access', 'grant_shipper'],
    },
  },
  { resource: 'ean', role: { key: 'shipper', name: 'Shipper', permissions: ['view', 'ship'] } },
  {
    resource: 'ean',
    role: {
      key: 'integration_client',
      name: 'Integration client',
      permissions: ['view', 'create_shipment'],
    },
  },
  {
    resource: 'ean',
    role: { key: 'integration_reader', name: 'Integration reader', permissions: ['view'] },
  },
  {
    resource: 'shipment',
    role: {
      key: 'account_admin',
      name: 'Account admin',
      permissions: [
        'view',
        'comment',
        'invite_collaborator',
        'approve_collaborator',
        'revoke_collaborator',
        'approve_renewal',
      ],
      granted_to: {
        users_with_role: [
          { role: 'account_admin', on_resource: 'ean', linked_by_relation: 'parent' },
        ],
      },
    },
  },
  {
    resource: 'account',
    role: {
      key: 'shipper',
      name: 'Shipper',
      permissions: ['view', 'ship'],
      granted_to: {
        users_with_role: [{ role: 'shipper', on_resource: 'ean', linked_by_relation: 'parent' }],
      },
    },
  },
  {
    resource: 'account',
    role: {
      key: 'account_manager',
      name: 'Account manager',
      permissions: ['view', 'ship', 'view_billing'],
    },
  },
  {
    resource: 'account',
    role: {
      key: 'account_admin',
      name: 'Account admin',
      permissions: ['view', 'view_billing', 'grant_account_manager'],
      granted_to: {
        users_with_role: [
          { role: 'account_admin', on_resource: 'ean', linked_by_relation: 'parent' },
        ],
      },
    },
  },
  {
    resource: 'location',
    role: { key: 'location_operator', name: 'Location operator', permissions: ['view', 'operate'] },
  },
  {
    resource: 'location',
    role: {
      key: 'account_admin',
      name: 'Account admin',
      permissions: ['view', 'grant_location_operator'],
      granted_to: {
        users_with_role: [
          { role: 'account_admin', on_resource: 'account', linked_by_relation: 'parent' },
        ],
      },
    },
  },
];

const all = (...conds: object[]) => ({ allOf: [{ allOf: conds }] });
export const CONDITION_SETS: ConditionSetCreate[] = [
  {
    key: 'verified_org_admin',
    name: 'Verified org admin',
    type: 'userset',
    conditions: all(
      { 'user.roles': { array_contains: 'org_admin' } },
      { 'user.identity_verified': { equals: true } },
      { 'user.duplicate_check': { equals: 'clear' } },
      { 'user.risk_state': { equals: 'ok' } },
    ),
  },
  {
    key: 'verified_organization',
    name: 'Verified organization',
    type: 'resourceset',
    resource_id: 'organization',
    conditions: all({ 'resource.ownership_verified': { equals: true } }),
  },
  {
    key: 'associated_ean',
    name: 'Associated EAN',
    type: 'resourceset',
    resource_id: 'ean',
    conditions: all({ 'resource.association_verified': { equals: true } }),
  },
  {
    key: 'active_collaborator',
    name: 'Active collaborator',
    type: 'userset',
    conditions: all({
      'user.time_based_grants': {
        any_match: {
          match: {
            resource: { equals: { ref: 'resource.id' } },
            role: { equals: 'collaborator' },
            expires: { 'greater-than-equals': { ref: 'user.current_time' } },
          },
        },
      },
    }),
  },
  {
    key: 'renewable_collaborator',
    name: 'Renewable collaborator',
    type: 'userset',
    conditions: all({
      'user.time_based_grants': {
        any_match: {
          match: {
            resource: { equals: { ref: 'resource.id' } },
            role: { equals: 'collaborator' },
            renewals_used: { 'less-than': 2 },
          },
        },
      },
    }),
  },
  {
    key: 'renewal_within_limit',
    name: 'Renewal within limit',
    type: 'resourceset',
    resource_id: 'shipment',
    conditions: all({ 'resource.requested_days': { 'less-than-equals': 30 } }),
  },
];

type Rule = { user_set: string; resource_set: string; permission: string; is_resource?: boolean };
const rules = (
  user_set: string,
  resource_set: string,
  perms: string[],
  is_resource = false,
): Rule[] =>
  perms.map((permission) => ({
    user_set,
    resource_set,
    permission,
    ...(is_resource ? { is_resource: true } : {}),
  }));
export const CONDITION_SET_RULES: Rule[] = [
  ...rules('verified_org_admin', 'verified_organization', [
    'organization:manage_members',
    'organization:invite',
    'organization:transfer_admin',
    'organization:request_ean_association',
  ]),
  ...rules('verified_org_admin', 'associated_ean', [
    'ean:view',
    'ean:ship',
    'ean:view_billing',
    'ean:manage_access',
  ]),
  ...rules(
    'verified_org_admin',
    'shipment',
    [
      'shipment:view',
      'shipment:approve_collaborator',
      'shipment:revoke_collaborator',
      'shipment:approve_renewal',
    ],
    true,
  ),
  // The org admin's grant rights anywhere in the tenant, the only S2/S5 rights that read
  // attributes. Only this rule grants account admin on an EAN and approves an integration.
  ...rules('verified_org_admin', 'associated_ean', [
    'ean:grant_shipper',
    'ean:grant_account_admin',
    'ean:approve_integration',
  ]),
  ...rules(
    'verified_org_admin',
    'account',
    ['account:view', 'account:view_billing', 'account:grant_account_manager'],
    true,
  ),
  ...rules(
    'verified_org_admin',
    'location',
    ['location:view', 'location:grant_location_operator'],
    true,
  ),
  ...rules(
    'active_collaborator',
    'shipment',
    ['shipment:view', 'shipment:upload_docs', 'shipment:comment'],
    true,
  ),
  ...rules('renewable_collaborator', 'renewal_within_limit', ['shipment:request_renewal']),
];
