import { describe, expect, it } from 'vitest';
import { RESOURCES, RELATIONS, TENANT_ROLES, RESOURCE_ROLES, CONDITION_SETS, CONDITION_SET_RULES } from '../scripts/policy';

const gated = new Set(CONDITION_SET_RULES.map((r) => r.permission));
function numbersInsideAnyMatch(node: unknown, inside = false): number[] {
  if (typeof node === 'number') return inside ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((n) => numbersInsideAnyMatch(n, inside));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => numbersInsideAnyMatch(v, inside || k === 'any_match'));
  return [];
}

describe('policy model', () => {
  it('no tenant role grants a gated action', () => {
    for (const role of TENANT_ROLES) for (const p of role.permissions) expect(gated.has(p), `${role.key} grants gated ${p}`).toBe(false);
  });
  it('no resource role grants a gated action on its own resource', () => {
    // EAN-scoped admins legitimately hold these, including shipment:comment.
    // upload_docs and request_renewal stay collaborator-only: a resource role granting them would bypass expiry.
    // An EAN admin grants inside their own EAN: grant_shipper on it, and through `parent` the grant rights
    // on its child accounts and their locations. grant_account_admin and approve_integration stay with the verified
    // org admin alone, so they are not on this list.
    for (const rr of RESOURCE_ROLES) for (const a of rr.role.permissions ?? []) {
      const p = `${rr.resource}:${a}`;
      const ok = !gated.has(p) || [
        'shipment:view', 'shipment:comment', 'shipment:approve_collaborator', 'shipment:revoke_collaborator', 'shipment:approve_renewal',
        'ean:view', 'ean:ship', 'ean:view_billing', 'ean:manage_access',
        'ean:grant_shipper', 'account:view', 'account:view_billing', 'account:grant_account_manager', 'location:view', 'location:grant_location_operator',
      ].includes(p);
      expect(ok, `${rr.resource}#${rr.role.key} grants ${p}`).toBe(true);
    }
  });
  it('every new resource role derives only through a declared relation', () => {
    // A derived role names the role it comes from, on the resource at the other end of a relation the child declares.
    // That role must be created first: seed writes RESOURCE_ROLES in order, and Permit refuses a derivation from a role it lacks.
    const declared = new Set<string>();
    for (const { resource, role } of RESOURCE_ROLES) {
      for (const from of role.granted_to?.users_with_role ?? []) {
        const relation = RELATIONS.find((r) => r.resource === resource && r.relation.key === from.linked_by_relation);
        expect(relation, `${resource}#${role.key} derives through ${from.linked_by_relation}, which ${resource} does not declare`).toBeDefined();
        expect(relation?.relation.subject_resource, `${resource}#${role.key}`).toBe(from.on_resource);
        expect(declared.has(`${from.on_resource}#${from.role}`), `${resource}#${role.key} derives from ${from.on_resource}#${from.role}, declared later or not at all`).toBe(true);
      }
      declared.add(`${resource}#${role.key}`);
    }
    // The derivations S2 relies on: shipper and account admin flow from an EAN to its child accounts, and account admin on to their locations.
    const derivations = RESOURCE_ROLES.flatMap(({ resource, role }) =>
      (role.granted_to?.users_with_role ?? []).map((from) => `${from.on_resource}#${from.role} -> ${resource}#${role.key}`));
    expect(derivations).toEqual([
      'ean#account_admin -> shipment#account_admin',
      'ean#shipper -> account#shipper',
      'ean#account_admin -> account#account_admin',
      'account#account_admin -> location#account_admin',
    ]);
  });
  it('lets only the verified org admin grant account admin on an EAN or approve an integration', () => {
    for (const p of ['ean:grant_account_admin', 'ean:approve_integration']) {
      expect(CONDITION_SET_RULES.filter((r) => r.permission === p).map((r) => r.user_set), p).toEqual(['verified_org_admin']);
      for (const rr of RESOURCE_ROLES) expect(rr.role.permissions?.map((a) => `${rr.resource}:${a}`), `${rr.resource}#${rr.role.key}`).not.toContain(p);
    }
  });
  it('no 0 or 1 constants inside any_match', () => {
    for (const cs of CONDITION_SETS) expect(numbersInsideAnyMatch(cs.conditions).filter((n) => n === 0 || n === 1), cs.key).toEqual([]);
  });
  it('every rule permission names a declared action', () => {
    const actions = new Set(RESOURCES.flatMap((r) => Object.keys(r.actions).map((a) => `${r.key}:${a}`)));
    for (const rule of CONDITION_SET_RULES) expect(actions.has(rule.permission), rule.permission).toBe(true);
  });
});
