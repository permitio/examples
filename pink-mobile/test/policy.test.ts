import { describe, expect, it } from 'vitest';
import { MANAGER_KEY } from '#lib/model';
import {
  conditionSetRules,
  conditionSets,
  relationshipTuples,
  resourceInstances,
  resources,
  roleAssignments,
  roles,
  users,
} from '#lib/policy';

const actionsOf = new Map(resources.map((r) => [r.key, Object.keys(r.actions)]));
const resourceRolesOf = new Map(resources.map((r) => [r.key, Object.keys(r.roles ?? {})]));
const permissions = resources.flatMap((r) => Object.keys(r.actions).map((a) => `${r.key}:${a}`));
const userKeys = new Set(users.map((user) => user.key));
const instanceKeys = new Set(resourceInstances.map((i) => `${i.resource}:${i.key}`));

describe('the policy in lib/policy.ts', () => {
  it('grants tenant roles only actions its resources define', () => {
    for (const role of roles) {
      for (const permission of role.permissions ?? []) {
        expect(permissions, `${role.key} grants ${permission}`).toContain(permission);
      }
    }
  });

  it('grants resource roles only actions of their own resource', () => {
    for (const resource of resources) {
      for (const [role, { permissions: granted }] of Object.entries(
        (resource.roles ?? {}) as Record<string, { permissions: string[] }>,
      )) {
        for (const action of granted) {
          expect(actionsOf.get(resource.key), `${resource.key}#${role} grants ${action}`).toContain(
            action,
          );
        }
      }
    }
  });

  it('defines each resource before a resource that relates to it', () => {
    const order = resources.map((r) => r.key);
    for (const [index, resource] of resources.entries()) {
      for (const target of Object.values((resource.relations ?? {}) as Record<string, string>)) {
        expect(order.indexOf(target), `${resource.key} relates to ${target}`).toBeLessThan(index);
      }
    }
  });

  it('writes rules only for defined condition sets and permissions', () => {
    const sets = new Set(conditionSets.map((set) => set.key));
    for (const rule of conditionSetRules) {
      expect(sets.has(rule.user_set) && sets.has(rule.resource_set)).toBe(true);
      expect(permissions).toContain(rule.permission);
    }
  });
});

describe('the demo data in lib/policy.ts', () => {
  it('assigns only seeded users, to roles that exist where they are granted', () => {
    const tenantRoles = new Set(roles.map((role) => role.key));
    for (const { user, role, resource_instance: instance } of roleAssignments) {
      expect(userKeys.has(user), user).toBe(true);
      if (instance === undefined) {
        expect(tenantRoles.has(role), role).toBe(true);
      } else {
        expect(instanceKeys.has(instance), instance).toBe(true);
        expect(
          resourceRolesOf.get(instance.split(':')[0] ?? ''),
          `${role} on ${instance}`,
        ).toContain(role);
      }
    }
  });

  it("makes each customer's account the parent of their plan", () => {
    const customers = ['harry', 'hermione', 'ron'];
    expect(relationshipTuples.map((t) => `${t.subject} ${t.relation} ${t.object}`)).toEqual(
      customers.map((key) => `account:${key} parent plan:${key}`),
    );
    for (const key of customers) {
      expect(instanceKeys.has(`account:${key}`) && instanceKeys.has(`plan:${key}`)).toBe(true);
    }
  });

  it('starts the demo scenarios: Ron blocked, Hermione a member only, one manager', () => {
    const ron = users.find((user) => user.key === 'ron@weasley.me');
    expect(ron?.attributes).toEqual({ plan: 'Standard', blocked: true });
    const hermione = roleAssignments.filter((a) => a.user === 'hermione@granger.app');
    expect(hermione).toEqual([
      expect.objectContaining({ role: 'member', resource_instance: 'account:harry' }),
    ]);
    expect(roleAssignments.filter((a) => a.role === 'manager').map((a) => a.user)).toEqual([
      MANAGER_KEY,
    ]);
  });
});
