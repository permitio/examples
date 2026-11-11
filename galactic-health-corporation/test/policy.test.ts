import type { Permit } from 'permitio';
import { describe, expect, it } from 'vitest';
import { permitApiError, permitFake } from '#test/permit-fake';
import {
  applyPolicy,
  PILOT_GROUP_ROLES,
  RELATIONS,
  RESOURCE_ROLES,
  RESOURCES,
} from '#scripts/policy';

const permit = permitFake as unknown as Permit;

function run() {
  const lines: string[] = [];
  return { lines, done: applyPolicy(permit, (line) => lines.push(line)) };
}

describe('applyPolicy', () => {
  it('creates every resource, relation, resource role and pilot-group role', async () => {
    const { lines, done } = run();
    await done;

    expect(permitFake.api.resources.create).toHaveBeenCalledTimes(RESOURCES.length);
    expect(permitFake.api.resources.create).toHaveBeenCalledWith({
      key: 'health_plan',
      name: 'Health Plan',
      actions: { read: {} },
    });
    expect(permitFake.api.resourceRelations.create).toHaveBeenCalledWith('profile', {
      key: 'belongs',
      name: 'Belongs',
      subject_resource: 'member_group',
    });
    expect(permitFake.api.resourceRoles.create).toHaveBeenCalledWith('profile', {
      key: 'caregiver',
      name: 'Caregiver',
      permissions: ['read'],
      granted_to: {
        users_with_role: [
          { role: 'org_member', on_resource: 'member_group', linked_by_relation: 'belongs' },
          { role: 'caregiver', on_resource: 'member', linked_by_relation: 'parent' },
        ],
      },
    });
    expect(permitFake.api.roles.create).toHaveBeenCalledWith({
      key: 'benefits_pg_role',
      name: 'Benefits Pilot Group',
      permissions: ['benefits_pg:view'],
    });
    const total =
      RESOURCES.length + RELATIONS.length + RESOURCE_ROLES.length + PILOT_GROUP_ROLES.length;
    expect(lines.filter((line) => line.includes('created'))).toHaveLength(total);
  });

  it('writes in dependency order: resources, relations, then roles that derive through them', async () => {
    await run().done;
    const lastResource = Math.max(...permitFake.api.resources.create.mock.invocationCallOrder);
    const firstRelation = Math.min(
      ...permitFake.api.resourceRelations.create.mock.invocationCallOrder,
    );
    const lastRelation = Math.max(
      ...permitFake.api.resourceRelations.create.mock.invocationCallOrder,
    );
    const firstRole = Math.min(...permitFake.api.resourceRoles.create.mock.invocationCallOrder);
    expect(lastResource).toBeLessThan(firstRelation);
    expect(lastRelation).toBeLessThan(firstRole);
    // Roles derived from member_group#org_member come after it.
    const roleOrder = permitFake.api.resourceRoles.create.mock.calls.map(
      ([resource, role]) => `${String(resource)}#${(role as { key: string }).key}`,
    );
    expect(roleOrder.indexOf('member_group#org_member')).toBeLessThan(
      roleOrder.indexOf('profile#caregiver'),
    );
  });

  it('updates what exists (409) and keeps existing relations as they are', async () => {
    const conflict = async () => {
      throw permitApiError(409);
    };
    permitFake.api.resources.create.mockImplementation(conflict);
    permitFake.api.resourceRelations.create.mockImplementation(conflict);
    permitFake.api.resourceRoles.create.mockImplementation(conflict);
    permitFake.api.roles.create.mockImplementation(conflict);

    const { lines, done } = run();
    await done;

    expect(permitFake.api.resources.update).toHaveBeenCalledWith('benefits_pg', {
      name: 'Benefits',
      actions: { view: {} },
      description: 'The benefits card, shown to the Benefits pilot group.',
    });
    expect(permitFake.api.resourceRoles.update).toHaveBeenCalledWith('health_plan', 'owner', {
      name: 'Owner',
      permissions: ['read'],
      granted_to: {
        users_with_role: [{ role: 'owner', on_resource: 'member', linked_by_relation: 'parent' }],
      },
    });
    expect(permitFake.api.roles.update).toHaveBeenCalledTimes(PILOT_GROUP_ROLES.length);
    expect(lines.filter((line) => line.includes('exists'))).toHaveLength(RELATIONS.length);
    expect(lines.some((line) => line.includes('created'))).toBe(false);
  });

  it('stops at the first error that is not a conflict, naming the object', async () => {
    permitFake.api.resources.create.mockRejectedValueOnce(permitApiError(403, 'key lacks access'));
    await expect(run().done).rejects.toThrow('resource member_group: key lacks access');
    expect(permitFake.api.resourceRelations.create).not.toHaveBeenCalled();
  });

  it('reports a failed update with the object name', async () => {
    permitFake.api.roles.create.mockRejectedValueOnce(permitApiError(409));
    permitFake.api.roles.update.mockRejectedValueOnce(permitApiError(422, 'unknown permission'));
    await expect(run().done).rejects.toThrow('role benefits_pg_role: unknown permission');
  });
});
