import { type Response, Router } from 'express';
import type { IUserPermissions } from 'permitio';
import type { Deps } from '#src/server/app';
import { deniedBy, HttpError } from '#src/server/errors';
import { RESOURCE, ROLE, type SeedData, TENANT } from '#src/server/model';
import type { ResourceRef } from '#src/server/permit/enforcer';
import { ensureInstanceRole, ensureNoInstanceRole } from '#src/server/permit/instance-roles';
import { personaOf, sourceOf } from '#src/server/personas';
import { SANDBOX_EAN } from '#src/server/routes/s5';
import { type Body, bodyOf, text } from '#src/server/routes/validate';

type GrantType = typeof RESOURCE.ean | typeof RESOURCE.account | typeof RESOURCE.location;

/**
 * The roles Team access grants, the kind of resource each goes on, and the Permit action that
 * guards it: a grant is itself a permission, `grant_<role>` on the resource the role is given on.
 * This is the only place they are listed, and its order is the order the form offers them in.
 */
const GRANTABLE: ReadonlyArray<{ role: string; on: GrantType; action: string }> = [
  { role: ROLE.shipper, on: RESOURCE.ean, action: 'grant_shipper' },
  { role: ROLE.accountAdmin, on: RESOURCE.ean, action: 'grant_account_admin' },
  { role: ROLE.accountManager, on: RESOURCE.account, action: 'grant_account_manager' },
  { role: ROLE.locationOperator, on: RESOURCE.location, action: 'grant_location_operator' },
];
type Grantable = (typeof GRANTABLE)[number];

/**
 * What a persona who names their own access is told: Team access changes other people's access,
 * never one's own.
 */
const OWN_ACCESS = "You can't change your own access here.";

/**
 * A resource a role could go on: what to ask Permit about, what to call it, and the resource above
 * it (`type:key`).
 */
interface Place {
  ref: ResourceRef;
  name: string;
  parent: string | null;
}

/**
 * Shire Freight's places a role can go on, by kind, from the seed: its EANs that are in Permit,
 * then the child accounts under those EANs, then the locations under those accounts. Never S5's
 * integration sandbox, where a connector's test scope lives: it is no place to give a person a
 * role.
 */
function placesOf(seed: SeedData): Record<GrantType, Place[]> {
  const ref = (type: GrantType, key: string): ResourceRef => ({ type, key, tenant: TENANT.shire });
  const eans = seed.eans.filter(
    (e) => e.org === TENANT.shire && e.in_permit && e.key !== SANDBOX_EAN,
  );
  const accounts = seed.accounts.filter((a) => eans.some((e) => e.key === a.ean));
  const locations = seed.locations.filter((l) => accounts.some((a) => a.key === l.account));
  return {
    [RESOURCE.ean]: eans.map((e) => ({ ref: ref(RESOURCE.ean, e.key), name: e.key, parent: null })),
    [RESOURCE.account]: accounts.map((a) => ({
      ref: ref(RESOURCE.account, a.key),
      name: a.name,
      parent: `${RESOURCE.ean}:${a.ean}`,
    })),
    [RESOURCE.location]: locations.map((l) => ({
      ref: ref(RESOURCE.location, l.key),
      name: l.name,
      parent: `${RESOURCE.account}:${l.account}`,
    })),
  };
}

/**
 * Shire Freight's people, whom Team access gives roles to: the seeded personas whose company is the
 * organization's name.
 */
export function membersOf(seed: SeedData): Array<{ key: string; name: string }> {
  const company = seed.organizations.find((o) => o.key === TENANT.shire)?.name;
  return seed.personas
    .filter((p) => p.company === company)
    .map((p) => ({ key: p.key, name: p.name }));
}

/**
 * A path or body value naming one of Shire Freight's people: nobody else's roles or permissions are
 * Team access's to show or change.
 */
function memberKey(seed: SeedData, key: string): string {
  if (!membersOf(seed).some((m) => m.key === key))
    throw new HttpError(400, `Unknown member ${key}`);
  return key;
}

/** `type:key` as its two parts; undefined when either is missing. */
function splitResource(resource: string): { type: string; key: string } | undefined {
  const colon = resource.indexOf(':');
  return colon <= 0 || colon === resource.length - 1
    ? undefined
    : { type: resource.slice(0, colon), key: resource.slice(colon + 1) };
}

interface Grant {
  user: string;
  role: Grantable;
  ref: ResourceRef;
  instance: string;
}

/**
 * Reads a grant, and a revoke, which name the same three things: a member, a role and the resource
 * it goes on (`type:key`). Everything that can be refused without asking Permit is refused here, so
 * a malformed or impossible request neither costs a check nor reaches a write. A well-formed one
 * that Permit denies is the check's to refuse.
 */
function grantOf(d: Deps, body: Body): Grant {
  const user = memberKey(d.seed, text(body, 'user'));
  const roleKey = text(body, 'role');
  const role = GRANTABLE.find((g) => g.role === roleKey);
  if (!role) throw new HttpError(400, `Unknown role ${roleKey}`);
  const resource = text(body, 'resource');
  const parts = splitResource(resource);
  if (!parts) throw new HttpError(400, 'resource must look like type:key');
  if (parts.type !== role.on)
    throw new HttpError(400, `${role.role} is granted on ${role.on}, not on ${parts.type}`);
  const place = placesOf(d.seed)[role.on].find((p) => p.ref.key === parts.key);
  if (!place) throw new HttpError(400, `Unknown resource ${resource}`);
  return { user, role, ref: place.ref, instance: resource };
}

/**
 * What Team access manages in a role a member holds on one resource: the table's entry for that
 * role and the place it is held on, or undefined when it manages neither (a role outside the table,
 * or a resource that is not on offer, such as the sandbox). Team access can neither give nor take
 * away such a role, so there is no `grant_` question to ask about it.
 */
function managedBy(
  places: Record<GrantType, Place[]>,
  a: { role: string; resource_instance?: string },
): { g: Grantable; place: Place } | undefined {
  const parts = a.resource_instance ? splitResource(a.resource_instance) : undefined;
  const g = parts && GRANTABLE.find((x) => x.role === a.role && x.on === parts.type);
  const place = g && parts && places[g.on].find((p) => p.ref.key === parts.key);
  return g && place ? { g, place } : undefined;
}

/**
 * One row of Merry's "What I can do" grid: a resource, the roles held on it and the actions they
 * allow there.
 */
interface PermissionRow {
  resource: string;
  name: string;
  roles: string[];
  actions: string[];
}

/** The kinds of resource the grid lists, in the order it lists them. */
const GRID_TYPES: readonly string[] = [RESOURCE.ean, RESOURCE.account, RESOURCE.location];
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The grid from the PDP's user-permissions answer: the entries on an EAN, a child account or a
 * location, EANs first, then accounts, then locations, each kind by key. The tenant's own entry
 * (`__tenant:…`) and other kinds, such as shipments, are not part of it. The PDP lists an action
 * with its type (`ean:view`); the grid shows `view`. What the PDP lists is all there is: a resource
 * it does not list shows no row.
 */
function rowsOf(seed: SeedData, answer: IUserPermissions): PermissionRow[] {
  const names = new Map<string, string>([
    ...seed.accounts.map((a): [string, string] => [`${RESOURCE.account}:${a.key}`, a.name]),
    ...seed.locations.map((l): [string, string] => [`${RESOURCE.location}:${l.key}`, l.name]),
  ]);
  return Object.entries(answer)
    .flatMap(([resource, entry]) => {
      const colon = resource.indexOf(':');
      if (colon <= 0) return [];
      const type = resource.slice(0, colon);
      const rank = GRID_TYPES.indexOf(type);
      if (rank < 0) return [];
      const prefix = `${type}:`;
      const actions = entry.permissions.map((p) =>
        p.startsWith(prefix) ? p.slice(prefix.length) : p,
      );
      return [
        {
          rank,
          row: {
            resource,
            name: names.get(resource) ?? resource.slice(colon + 1),
            roles: entry.roles ?? [],
            actions,
          },
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank || byText(a.row.resource, b.row.resource))
    .map(({ row }) => row);
}

/**
 * S2, delegated administration: Team access, which offers each admin only the grants Permit lets
 * them make and makes them, and Merry's "What I can do", under /api/s2. The reads keep the scope
 * the writes keep: a member's assignments are listed only as far as the persona could grant them,
 * and a persona sees only their own permissions. A persona route: app.ts mounts it behind the
 * persona middleware.
 */
export function s2Router(d: Deps): Router {
  const r = Router();

  // How S2's routes ask Permit before a write: `await enforce(res, action, resource)`. It takes the
  // persona from the request, and a deny stops the request with 403 before anything is written.
  // Underneath, enforcer.ts adds the time and calls permit.check.
  const enforce = async (res: Response, action: string, ref: ResourceRef) => {
    if (!(await d.enforcer.check(personaOf(res), action, ref, { source: sourceOf(res) })))
      throw deniedBy(action, ref);
  };
  // The portal's own rule, before Permit is asked: the form never offers the signed-in persona, and
  // the API refuses what the form never offers. A role an admin gave themselves would bring grant
  // rights of its own, which S1's kill switch on the admin's trust facts would not stop; taking
  // one's own role away is refused the same way.
  const notOwnAccess = (res: Response, user: string) => {
    if (user === personaOf(res)) throw new HttpError(403, OWN_ACCESS);
  };

  r.get('/s2/team', async (_req, res) => {
    const persona = personaOf(res);
    const places = placesOf(d.seed);
    const pairs = GRANTABLE.flatMap((g) => places[g.on].map((place) => ({ g, place })));
    // Permit check, one per role and resource it could go on: which grants may this persona make?
    // The form offers only those.
    const decisions = await d.enforcer.bulk(
      persona,
      pairs.map(({ g, place }) => ({ action: g.action, ref: place.ref })),
      { source: sourceOf(res) },
    );
    res.json({
      members: membersOf(d.seed),
      grantable: pairs
        .filter((_pair, i) => decisions[i] === true)
        .map(({ g, place }) => ({
          role: g.role,
          resource: `${place.ref.type}:${place.ref.key}`,
          name: place.name,
          parent: place.parent,
        })),
    });
  });

  r.get('/s2/members/:user/assignments', async (req, res) => {
    const persona = personaOf(res);
    const user = memberKey(d.seed, req.params.user);
    // Permit read, for display: the roles this member holds on single resources in Shire Freight,
    // which the form shows as toggles.
    const held = await d.permitApi.roleAssignments.list({ user, tenant: TENANT.shire });
    const places = placesOf(d.seed);
    const managed = held.flatMap((a) => {
      const found = managedBy(places, a);
      return found
        ? [
            {
              role: a.role,
              resource: `${found.place.ref.type}:${found.place.ref.key}`,
              action: found.g.action,
              ref: found.place.ref,
            },
          ]
        : [];
    });
    // Permit check, one per assignment (none when there is none): may this persona give or take
    // away this role on this resource? The read keeps the scope the writes keep, so Frodo is never
    // shown a role on EAN-1002.
    const decisions = await d.enforcer.bulk(
      persona,
      managed.map(({ action, ref }) => ({ action, ref })),
      { source: sourceOf(res) },
    );
    res.json({
      assignments: managed
        .filter((_a, i) => decisions[i] === true)
        .map(({ role, resource }) => ({ role, resource })),
    });
  });

  r.post('/s2/grants', async (req, res) => {
    const { user, role, ref, instance } = grantOf(d, bodyOf(req));
    notOwnAccess(res, user);
    // Permit check: may this persona give this role on this exact resource?
    await enforce(res, role.action, ref);
    // Permit write: the role on that one resource, confirmed on the PDP. Permit takes a role the
    // member holds already with success, so a repeat is written and confirmed again and changes
    // nothing; a 409, should Permit answer one, is done (ms 0).
    const ms = await ensureInstanceRole(d, user, role.role, TENANT.shire, instance);
    res.status(201).json({ ms });
  });

  r.delete('/s2/grants', async (req, res) => {
    const { user, role, ref, instance } = grantOf(d, bodyOf(req));
    notOwnAccess(res, user);
    // Permit check: may this persona take this role away on this exact resource? The same grant_
    // action as giving it.
    await enforce(res, role.action, ref);
    // Permit write: the role on that one resource removed, confirmed on the PDP. Not held (Permit's
    // 404) is done, with ms 0.
    const ms = await ensureNoInstanceRole(d, user, role.role, TENANT.shire, instance);
    res.json({ ms });
  });

  r.get('/s2/permissions/:user', async (req, res) => {
    const persona = personaOf(res);
    // "What I can do" is self-service: a persona sees their own grid and nobody else's, so nothing
    // is asked for anyone else.
    if (req.params.user !== persona)
      throw new HttpError(403, 'You can only see your own permissions.');
    const user = memberKey(d.seed, persona);
    // Permit check: what does the PDP say this member may do in Shire Freight, on which EANs, child
    // accounts and locations?
    const answer = await d.enforcer.permissions(user, [TENANT.shire], { source: sourceOf(res) });
    res.json({ rows: rowsOf(d.seed, answer) });
  });

  return r;
}
