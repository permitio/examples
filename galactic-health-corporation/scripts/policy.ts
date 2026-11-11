/**
 * The example's Permit policy: resources and actions, the ReBAC relations between them, the
 * resource roles (some derived through those relations) and the pilot-group roles. `applyPolicy`
 * writes it to the environment of the API key; existing objects are updated, so it is safe to
 * re-run.
 */
import type { Permit, ResourceCreate, RoleCreate } from 'permitio';
import { describePermitError, permitStatus } from '@/lib/permit';

// The SDK's package entry does not export these two request types.
type RelationCreate = Parameters<Permit['api']['resourceRelations']['create']>[1];
type ResourceRoleCreate = Parameters<Permit['api']['resourceRoles']['create']>[1];
type Action = Record<string, Record<string, never>>;

function actions(...keys: string[]): Action {
  return Object.fromEntries(keys.map((key) => [key, {}]));
}

export const RESOURCES: ResourceCreate[] = [
  { key: 'member_group', name: 'Member Group', actions: actions('list', 'assign') },
  { key: 'member', name: 'Member', actions: actions('read', 'write') },
  { key: 'profile', name: 'Profile', actions: actions('read', 'write') },
  { key: 'health_plan', name: 'Health Plan', actions: actions('read') },
  { key: 'medical_records', name: 'Medical Records', actions: actions('read') },
  {
    key: 'benefits_pg',
    name: 'Benefits',
    description: 'The benefits card, shown to the Benefits pilot group.',
    actions: actions('view'),
  },
  {
    key: 'alt_medicine_pg',
    name: 'Alternative Medicine',
    description: 'The alternative medicine card, shown to the Alternative Medicine pilot group.',
    actions: actions('view'),
  },
];

/** ReBAC relations: `<subject_resource> is <relation> of <resource>`. */
export const RELATIONS: { resource: string; relation: RelationCreate }[] = [
  {
    resource: 'profile',
    relation: { key: 'belongs', name: 'Belongs', subject_resource: 'member_group' },
  },
  { resource: 'profile', relation: { key: 'parent', name: 'Parent', subject_resource: 'member' } },
  {
    resource: 'health_plan',
    relation: { key: 'parent', name: 'Parent', subject_resource: 'member' },
  },
  {
    resource: 'medical_records',
    relation: { key: 'parent', name: 'Parent', subject_resource: 'member' },
  },
];

function fromMember(role: 'owner' | 'caregiver') {
  return { role, on_resource: 'member', linked_by_relation: 'parent' };
}

/**
 * Resource roles. `granted_to` derives a role from a role on a related instance: the owner and
 * caregivers of a member get the same role on that member's profile, health plan and medical
 * records, and a member group's org_members become caregivers of the profiles that belong to it.
 */
export const RESOURCE_ROLES: { resource: string; role: ResourceRoleCreate }[] = [
  {
    resource: 'member_group',
    role: { key: 'admin', name: 'Admin', permissions: ['list', 'assign'] },
  },
  {
    resource: 'member_group',
    role: { key: 'org_member', name: 'Org Member', permissions: ['list'] },
  },
  { resource: 'member', role: { key: 'owner', name: 'Owner', permissions: ['read', 'write'] } },
  { resource: 'member', role: { key: 'caregiver', name: 'Caregiver', permissions: ['read'] } },
  {
    resource: 'profile',
    role: {
      key: 'owner',
      name: 'Owner',
      permissions: ['read', 'write'],
      granted_to: { users_with_role: [fromMember('owner')] },
    },
  },
  {
    resource: 'profile',
    role: {
      key: 'caregiver',
      name: 'Caregiver',
      permissions: ['read'],
      granted_to: {
        users_with_role: [
          { role: 'org_member', on_resource: 'member_group', linked_by_relation: 'belongs' },
          fromMember('caregiver'),
        ],
      },
    },
  },
  ...(['health_plan', 'medical_records'] as const).flatMap((resource) => [
    {
      resource,
      role: {
        key: 'owner',
        name: 'Owner',
        permissions: ['read'],
        granted_to: { users_with_role: [fromMember('owner')] },
      },
    },
    {
      resource,
      role: {
        key: 'caregiver',
        name: 'Caregiver',
        permissions: ['read'],
        granted_to: { users_with_role: [fromMember('caregiver')] },
      },
    },
  ]),
];

/** Tenant roles for the pilot groups (RBAC): each one shows one card on the dashboard. */
export const PILOT_GROUP_ROLES: RoleCreate[] = [
  { key: 'benefits_pg_role', name: 'Benefits Pilot Group', permissions: ['benefits_pg:view'] },
  {
    key: 'alt_medicine_pg_role',
    name: 'Alternative Medicine Pilot Group',
    permissions: ['alt_medicine_pg:view'],
  },
];

export type Log = (line: string) => void;

/**
 * Creates an object, or updates it when Permit answers 409 (it exists). Without `update`, a 409
 * means there is nothing to change. Other errors are rethrown with the label.
 */
export async function upsert(
  label: string,
  log: Log,
  create: () => Promise<unknown>,
  update?: () => Promise<unknown>,
): Promise<void> {
  try {
    await create();
    log(`  created ${label}`);
    return;
  } catch (error) {
    if (permitStatus(error) !== 409) {
      throw new Error(`${label}: ${describePermitError(error)}`, { cause: error });
    }
  }
  if (update === undefined) {
    log(`  exists  ${label}`);
    return;
  }
  try {
    await update();
    log(`  updated ${label}`);
  } catch (error) {
    throw new Error(`${label}: ${describePermitError(error)}`, { cause: error });
  }
}

/** Writes the policy above to Permit, in dependency order. */
export async function applyPolicy(permit: Permit, log: Log): Promise<void> {
  for (const resource of RESOURCES) {
    // Permit write: api.resources declares each resource type with its actions.
    await upsert(
      `resource ${resource.key}`,
      log,
      () => permit.api.resources.create(resource),
      () =>
        permit.api.resources.update(resource.key, {
          name: resource.name,
          actions: resource.actions,
          ...(resource.description === undefined ? {} : { description: resource.description }),
        }),
    );
  }
  for (const { resource, relation } of RELATIONS) {
    // Permit write: api.resourceRelations declares the ReBAC relations.
    await upsert(`relation ${resource}.${relation.key} <- ${relation.subject_resource}`, log, () =>
      permit.api.resourceRelations.create(resource, relation),
    );
  }
  for (const { resource, role } of RESOURCE_ROLES) {
    // Permit write: api.resourceRoles creates each resource role with its permissions and
    // derivations.
    await upsert(
      `resource role ${resource}#${role.key}`,
      log,
      () => permit.api.resourceRoles.create(resource, role),
      () =>
        permit.api.resourceRoles.update(resource, role.key, {
          name: role.name,
          ...(role.permissions === undefined ? {} : { permissions: role.permissions }),
          ...(role.granted_to === undefined ? {} : { granted_to: role.granted_to }),
        }),
    );
  }
  for (const role of PILOT_GROUP_ROLES) {
    // Permit write: api.roles creates the pilot-group tenant roles.
    await upsert(
      `role ${role.key}`,
      log,
      () => permit.api.roles.create(role),
      () =>
        permit.api.roles.update(role.key, {
          name: role.name,
          ...(role.permissions === undefined ? {} : { permissions: role.permissions }),
        }),
    );
  }
}
