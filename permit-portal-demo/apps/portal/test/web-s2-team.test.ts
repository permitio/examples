// The logic behind S2's pages that needs no browser: the Team access tree built from what Permit
// allowed, which toggle is on, and the grid's groups. The pages themselves (src/web/pages/s2/*.tsx)
// only draw these.
import { describe, expect, it } from 'vitest';
import {
  grantKey,
  groupRows,
  heldKeys,
  NO_TOGGLES,
  roleLabel,
  type ToggleState,
  toggleStateFor,
  type TreeNode,
  treeOf,
  withConfirmed,
} from '@/pages/s2/team';
import type { AssignmentsResponse, Grantable, PermissionRow } from '@/pages/s2/types';

const ean = (key: string, role: string): Grantable => ({
  role,
  resource: `ean:${key}`,
  name: key,
  parent: null,
});
const account = (
  key: string,
  name: string,
  parentEan: string,
  role = 'account_manager',
): Grantable => ({ role, resource: `account:${key}`, name, parent: `ean:${parentEan}` });
const location = (
  key: string,
  name: string,
  parentAccount: string,
  role = 'location_operator',
): Grantable => ({ role, resource: `location:${key}`, name, parent: `account:${parentAccount}` });

/** What Sam's team answer offers: every role everywhere, in the order the portal lists it. */
const SAMS_GRANTABLE: Grantable[] = [
  ean('EAN-1001', 'shipper'),
  ean('EAN-1002', 'shipper'),
  ean('EAN-1001', 'account_admin'),
  ean('EAN-1002', 'account_admin'),
  account('CA-1001-A', 'Hobbiton', 'EAN-1001'),
  account('CA-1001-B', 'Bywater', 'EAN-1001'),
  account('CA-1002-A', 'Michel Delving', 'EAN-1002'),
  location('LOC-BAGEND', 'Bag End depot', 'CA-1001-A'),
  location('LOC-BYWATER', 'Bywater depot', 'CA-1001-B'),
  location('LOC-FROGMORTON', 'Frogmorton depot', 'CA-1001-B'),
  location('LOC-MICHEL', 'Michel Delving depot', 'CA-1002-A'),
];
/** What Frodo's offers: EAN-1001's subtree, and no account_admin. */
const FRODOS_GRANTABLE: Grantable[] = [
  ean('EAN-1001', 'shipper'),
  account('CA-1001-A', 'Hobbiton', 'EAN-1001'),
  account('CA-1001-B', 'Bywater', 'EAN-1001'),
  location('LOC-BAGEND', 'Bag End depot', 'CA-1001-A'),
  location('LOC-BYWATER', 'Bywater depot', 'CA-1001-B'),
  location('LOC-FROGMORTON', 'Frogmorton depot', 'CA-1001-B'),
];

/** A tree as indented lines: "name [roles]" under its parent. */
function outline(nodes: readonly TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.name} [${n.roles.join(', ')}]`,
    ...outline(n.children, depth + 1),
  ]);
}

describe('treeOf', () => {
  it("draws Sam's offer as EAN, child accounts under it, locations under those, each with the roles Sam may give there", () => {
    expect(outline(treeOf(SAMS_GRANTABLE))).toEqual([
      'EAN-1001 [shipper, account_admin]',
      '  Hobbiton [account_manager]',
      '    Bag End depot [location_operator]',
      '  Bywater [account_manager]',
      '    Bywater depot [location_operator]',
      '    Frogmorton depot [location_operator]',
      'EAN-1002 [shipper, account_admin]',
      '  Michel Delving [account_manager]',
      '    Michel Delving depot [location_operator]',
    ]);
  });

  it("draws only EAN-1001's subtree for Frodo, with no account_admin toggle on it", () => {
    expect(outline(treeOf(FRODOS_GRANTABLE))).toEqual([
      'EAN-1001 [shipper]',
      '  Hobbiton [account_manager]',
      '    Bag End depot [location_operator]',
      '  Bywater [account_manager]',
      '    Bywater depot [location_operator]',
      '    Frogmorton depot [location_operator]',
    ]);
  });

  it('keeps each node by its type:key, so a toggle can say exactly where it applies', () => {
    const [root] = treeOf(FRODOS_GRANTABLE);
    expect(root?.resource).toBe('ean:EAN-1001');
    expect(root?.children.map((c) => c.resource)).toEqual([
      'account:CA-1001-A',
      'account:CA-1001-B',
    ]);
    expect(root?.children[1]?.children.map((c) => c.resource)).toEqual([
      'location:LOC-BYWATER',
      'location:LOC-FROGMORTON',
    ]);
  });

  it('puts a resource whose parent is not on offer at the top, so what Permit allowed is never hidden', () => {
    // Permit lets this admin give location_operator at Bywater depot, but nothing on the account
    // above it.
    expect(outline(treeOf([location('LOC-BYWATER', 'Bywater depot', 'CA-1001-B')]))).toEqual([
      'Bywater depot [location_operator]',
    ]);
    expect(
      outline(
        treeOf([ean('EAN-1001', 'shipper'), location('LOC-BYWATER', 'Bywater depot', 'CA-1001-B')]),
      ),
    ).toEqual(['EAN-1001 [shipper]', 'Bywater depot [location_operator]']);
  });

  it('lists a role once on a resource, in the order it came', () => {
    const [root] = treeOf([
      ean('EAN-1001', 'account_admin'),
      ean('EAN-1001', 'shipper'),
      ean('EAN-1001', 'account_admin'),
    ]);
    expect(root?.roles).toEqual(['account_admin', 'shipper']);
  });

  it('is empty when Permit allowed nothing', () => {
    expect(treeOf([])).toEqual([]);
  });
});

describe('which toggle is on', () => {
  it('keys a grant by role and resource together, so the same role on another resource is a different toggle', () => {
    expect(grantKey('shipper', 'ean:EAN-1001')).not.toBe(grantKey('shipper', 'ean:EAN-1002'));
    expect(grantKey('shipper', 'ean:EAN-1001')).not.toBe(grantKey('account_admin', 'ean:EAN-1001'));
  });

  it("is on for each of the member's assignments, and for nothing else", () => {
    const held = heldKeys([
      { role: 'shipper', resource: 'ean:EAN-1001' },
      { role: 'location_operator', resource: 'location:LOC-BYWATER' },
    ]);
    expect(held.has(grantKey('shipper', 'ean:EAN-1001'))).toBe(true);
    expect(held.has(grantKey('location_operator', 'location:LOC-BYWATER'))).toBe(true);
    expect(held.has(grantKey('shipper', 'ean:EAN-1002'))).toBe(false);
    expect(held.has(grantKey('location_operator', 'location:LOC-FROGMORTON'))).toBe(false);
  });

  it('names each role as the policy does', () => {
    expect([
      roleLabel('shipper'),
      roleLabel('account_admin'),
      roleLabel('account_manager'),
      roleLabel('location_operator'),
    ]).toEqual(['Shipper', 'Account admin', 'Account manager', 'Location operator']);
    expect(roleLabel('some_new_role')).toBe('some_new_role');
  });
});

// The page keeps its own copy of the toggles. It takes them from a read of the member's assignments
// (a person picked, Refresh, the tab shown again) and, once the PDP confirms a change, flips the
// toggle from what is on screen: asking the portal again would repeat the grant_ check on every
// assignment in the decision panel after every change.
describe('the toggles the page shows', () => {
  const read = (...held: Array<[role: string, resource: string]>): AssignmentsResponse => ({
    assignments: held.map(([role, resource]) => ({ role, resource })),
  });
  const isOn = (state: ToggleState, role: string, resource: string) =>
    state.held.has(grantKey(role, resource));
  const keysOf = (state: ToggleState) => [...state.held].sort();

  it("takes them from the read of the member's assignments: one on for each, and nothing before there is a read", () => {
    expect(toggleStateFor(NO_TOGGLES, undefined)).toBe(NO_TOGGLES);
    expect(NO_TOGGLES.held.size).toBe(0);
    const seeded = toggleStateFor(
      NO_TOGGLES,
      read(['shipper', 'ean:EAN-1001'], ['location_operator', 'location:LOC-BYWATER']),
    );
    expect(keysOf(seeded)).toEqual(
      [
        grantKey('location_operator', 'location:LOC-BYWATER'),
        grantKey('shipper', 'ean:EAN-1001'),
      ].sort(),
    );
    expect(isOn(seeded, 'shipper', 'ean:EAN-1002')).toBe(false);
  });

  it('a confirmed grant flips the toggle from the read the page already holds, without a second read', () => {
    const first = read(['shipper', 'ean:EAN-1001']);
    const before = structuredClone(first);
    const seeded = toggleStateFor(NO_TOGGLES, first);
    const granted = withConfirmed(seeded, 'account_manager', 'account:CA-1001-B', true);
    expect(isOn(granted, 'account_manager', 'account:CA-1001-B')).toBe(true);
    expect(isOn(granted, 'shipper', 'ean:EAN-1001')).toBe(true);
    // The page renders again with the same read in hand, since no new read was made: the confirmed
    // change stays.
    const rendered = toggleStateFor(granted, first);
    expect(rendered).toBe(granted);
    expect(isOn(rendered, 'account_manager', 'account:CA-1001-B')).toBe(true);
    // The read itself was only looked at.
    expect(first).toEqual(before);
  });

  it('a confirmed revoke turns the toggle off the same way', () => {
    const first = read(['shipper', 'ean:EAN-1001'], ['shipper', 'ean:EAN-1002']);
    const revoked = withConfirmed(
      toggleStateFor(NO_TOGGLES, first),
      'shipper',
      'ean:EAN-1002',
      false,
    );
    expect(isOn(revoked, 'shipper', 'ean:EAN-1002')).toBe(false);
    expect(isOn(revoked, 'shipper', 'ean:EAN-1001')).toBe(true);
    expect(toggleStateFor(revoked, first)).toBe(revoked);
  });

  it('flips one toggle and no other, not even the same role on another resource', () => {
    const seeded = toggleStateFor(NO_TOGGLES, read(['shipper', 'ean:EAN-1001']));
    const granted = withConfirmed(seeded, 'shipper', 'ean:EAN-1002', true);
    expect(keysOf(granted)).toEqual(
      [grantKey('shipper', 'ean:EAN-1001'), grantKey('shipper', 'ean:EAN-1002')].sort(),
    );
  });

  it('is a no-op to confirm what the toggle already says: a repeat Permit already had, answered with ms 0, changes nothing', () => {
    const seeded = toggleStateFor(NO_TOGGLES, read(['shipper', 'ean:EAN-1001']));
    expect(keysOf(withConfirmed(seeded, 'shipper', 'ean:EAN-1001', true))).toEqual(keysOf(seeded));
    expect(keysOf(withConfirmed(seeded, 'shipper', 'ean:EAN-1002', false))).toEqual(keysOf(seeded));
  });

  it('keeps changes confirmed one after another', () => {
    const first = read(['shipper', 'ean:EAN-1001']);
    let state = toggleStateFor(NO_TOGGLES, first);
    state = withConfirmed(state, 'account_manager', 'account:CA-1001-B', true);
    state = withConfirmed(state, 'location_operator', 'location:LOC-BYWATER', true);
    state = withConfirmed(state, 'shipper', 'ean:EAN-1001', false);
    state = toggleStateFor(state, first);
    expect(keysOf(state)).toEqual(
      [
        grantKey('account_manager', 'account:CA-1001-B'),
        grantKey('location_operator', 'location:LOC-BYWATER'),
      ].sort(),
    );
  });

  it('leaves the state it was given as it was', () => {
    const seeded = toggleStateFor(NO_TOGGLES, read(['shipper', 'ean:EAN-1001']));
    const before = keysOf(seeded);
    const granted = withConfirmed(seeded, 'shipper', 'ean:EAN-1002', true);
    expect(granted).not.toBe(seeded);
    expect(keysOf(seeded)).toEqual(before);
    expect(NO_TOGGLES.held.size).toBe(0);
  });

  it('takes the toggles afresh from a new read, which drops the changes made on the old one: Refresh, the tab shown again, another member', () => {
    const first = read(['shipper', 'ean:EAN-1001']);
    const changed = withConfirmed(
      toggleStateFor(NO_TOGGLES, first),
      'account_manager',
      'account:CA-1001-B',
      true,
    );
    // A new answer from the portal, even one that says the same as the old, is what the server
    // holds now.
    const refreshed = toggleStateFor(changed, read(['shipper', 'ean:EAN-1001']));
    expect(refreshed).not.toBe(changed);
    expect(keysOf(refreshed)).toEqual([grantKey('shipper', 'ean:EAN-1001')]);
    // Another member's read starts clean, and no read at all (while it loads) leaves nothing on.
    expect(
      keysOf(toggleStateFor(changed, read(['location_operator', 'location:LOC-BYWATER']))),
    ).toEqual([grantKey('location_operator', 'location:LOC-BYWATER')]);
    expect(keysOf(toggleStateFor(changed, undefined))).toEqual([]);
  });

  it('lays a change confirmed after a newer read over that newer read', () => {
    const older = read(['shipper', 'ean:EAN-1001']);
    const newer = read(['shipper', 'ean:EAN-1001'], ['shipper', 'ean:EAN-1002']);
    // A read lands while a change is being made; the change is confirmed after it.
    const state = withConfirmed(
      toggleStateFor(toggleStateFor(NO_TOGGLES, older), newer),
      'account_manager',
      'account:CA-1001-B',
      true,
    );
    expect(keysOf(state)).toEqual(
      [
        grantKey('account_manager', 'account:CA-1001-B'),
        grantKey('shipper', 'ean:EAN-1001'),
        grantKey('shipper', 'ean:EAN-1002'),
      ].sort(),
    );
    expect(toggleStateFor(state, newer)).toBe(state);
  });
});

describe('groupRows', () => {
  const row = (resource: string, name: string): PermissionRow => ({
    resource,
    name,
    roles: [],
    actions: [],
  });

  it('groups the grid as EANs, child accounts and locations, in that order, keeping the portal order inside each', () => {
    const groups = groupRows([
      row('ean:EAN-1001', 'EAN-1001'),
      row('account:CA-1001-A', 'Hobbiton'),
      row('account:CA-1001-B', 'Bywater'),
      row('location:LOC-BYWATER', 'Bywater depot'),
    ]);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
      ['EANs', ['EAN-1001']],
      ['Child accounts', ['Hobbiton', 'Bywater']],
      ['Locations', ['Bywater depot']],
    ]);
  });

  it('leaves out a group with no rows', () => {
    expect(groupRows([row('location:LOC-BYWATER', 'Bywater depot')]).map((g) => g.title)).toEqual([
      'Locations',
    ]);
    expect(groupRows([])).toEqual([]);
  });
});
