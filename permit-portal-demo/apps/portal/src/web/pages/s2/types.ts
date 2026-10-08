// Shapes of S2's API answers (routes/s2.ts), mirrored here so the browser bundle carries no server code.

/** One grant Permit lets this persona make: a role on a resource (`type:key`), with the resource above it (`null` for an EAN). */
export interface Grantable {
  role: string;
  resource: string;
  name: string;
  parent: string | null;
}

/** GET /api/s2/team */
export interface TeamResponse {
  members: Array<{ key: string; name: string }>;
  grantable: Grantable[];
}

/** GET /api/s2/members/:user/assignments: the member's roles on single resources, as far as the persona asking could give or take them away. */
export interface AssignmentsResponse {
  assignments: Array<{ role: string; resource: string }>;
}

/** The body of POST and DELETE /api/s2/grants: give, or take away, `role` on `resource` (`type:key`) for the member `user`. */
export interface GrantBody {
  user: string;
  role: string;
  resource: string;
}

/** What POST and DELETE /api/s2/grants answer: how long the PDP took to confirm the change, or 0 when it was already so. */
export interface GrantResponse {
  ms: number;
}

/** One row of the grid: a resource, the roles held on it and the actions they allow there. */
export interface PermissionRow {
  resource: string;
  name: string;
  roles: string[];
  actions: string[];
}

/** GET /api/s2/permissions/:user, which answers only for the persona asking: EANs first, then child accounts, then locations. */
export interface PermissionsResponse {
  rows: PermissionRow[];
}
