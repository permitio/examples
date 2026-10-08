// What S2's pages work out before they draw: the Team access tree, which toggle is on, and the grid's groups. No React
// here, so it is tested without a browser (test/web-s2-team.test.ts).

import type { AssignmentsResponse, Grantable, PermissionRow } from './types';

/** One resource of the Team access tree, with the roles the persona may give on it and what sits under it. */
export interface TreeNode {
  /** `type:key`. */
  resource: string;
  name: string;
  /** Each role Permit lets the persona give here, once, in the order the portal listed them. */
  roles: string[];
  children: TreeNode[];
}

/**
 * The tree EAN, child accounts under it, locations under those, built from what Permit allowed and nothing else, so a
 * persona's tree shows only their own part of it. A resource whose parent is not on offer (Permit allowed a location but
 * nothing on the account above it) goes at the top, so what Permit allowed is never hidden. Siblings keep the order the
 * portal listed them in.
 */
export function treeOf(grantable: readonly Grantable[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const parents = new Map<string, string | null>();
  for (const g of grantable) {
    const node = nodes.get(g.resource) ?? { resource: g.resource, name: g.name, roles: [], children: [] };
    if (!node.roles.includes(g.role)) node.roles.push(g.role);
    nodes.set(g.resource, node);
    parents.set(g.resource, g.parent);
  }
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parents.get(node.resource);
    const above = parent === null || parent === undefined ? undefined : nodes.get(parent);
    (above ? above.children : roots).push(node);
  }
  return roots;
}

/** The roles' names as the policy gives them. A role this page does not know shows as its key. */
const ROLE_LABEL: Readonly<Record<string, string>> = {
  shipper: 'Shipper',
  account_admin: 'Account admin',
  account_manager: 'Account manager',
  location_operator: 'Location operator',
};

export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role;

/** One toggle: a role on a resource. The same role on another resource is another toggle. */
export const grantKey = (role: string, resource: string): string => `${role} ${resource}`;

/** The toggles that are on: one for each role the member holds on a single resource. */
export function heldKeys(assignments: ReadonlyArray<{ role: string; resource: string }>): ReadonlySet<string> {
  return new Set(assignments.map((a) => grantKey(a.role, a.resource)));
}

/** What the page holds of the member's toggles: the read of the member's assignments they came from, and the toggles that are on. */
export interface ToggleState {
  read: AssignmentsResponse | undefined;
  held: ReadonlySet<string>;
}

/** Before there is a read: nothing is on. */
export const NO_TOGGLES: ToggleState = { read: undefined, held: new Set<string>() };

/**
 * The toggles for the read the page now holds. The same read as before keeps the state as it is, changes the PDP has
 * confirmed since included; a new read (a person picked, Refresh, the tab shown again) takes the toggles afresh from it,
 * which drops those changes, because the portal's answer is what Permit holds now.
 */
export function toggleStateFor(prev: ToggleState, read: AssignmentsResponse | undefined): ToggleState {
  return prev.read === read ? prev : { read, held: heldKeys(read?.assignments ?? []) };
}

/**
 * A change the PDP has confirmed, shown on the toggle straight away, from what is on screen. The page does not read the
 * member's assignments again: that would repeat the `grant_` check on every one of them in the decision panel after
 * every change, burying the check and the write this change made. A change the toggle already shows (a repeat Permit
 * already had) leaves it as it is. Answers a new state; the one given is not touched.
 */
export function withConfirmed(prev: ToggleState, role: string, resource: string, on: boolean): ToggleState {
  const held = new Set(prev.held);
  const key = grantKey(role, resource);
  if (on) held.add(key);
  else held.delete(key);
  return { read: prev.read, held };
}

const GROUPS = [
  { type: 'ean', title: 'EANs' },
  { type: 'account', title: 'Child accounts' },
  { type: 'location', title: 'Locations' },
] as const;

/** The grid's rows grouped by kind of resource, EANs first, then child accounts, then locations; a kind with no rows is left out. */
export function groupRows(rows: readonly PermissionRow[]): Array<{ type: string; title: string; rows: PermissionRow[] }> {
  return GROUPS.map(({ type, title }) => ({ type, title, rows: rows.filter((r) => r.resource.startsWith(`${type}:`)) })).filter((g) => g.rows.length > 0);
}
