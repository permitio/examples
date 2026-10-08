import { type Response, Router } from 'express';
import type { Deps } from '../app';
import { deniedBy, HttpError, statusOf } from '../errors';
import { effectiveAdmins } from '../guards';
import { RESOURCE, ROLE, type TrustFacts } from '../model';
import type { ResourceRef } from '../permit/enforcer';
import { resumableWrite, timedWrite } from '../permit/writes';
import { personaName, personaOf, sourceOf } from '../personas';
import { assign, ensureRole, QUEUE_REF, unassign } from './requests';
import { bodyOf, optionalText, personaKey, text } from './validate';

const ORG_ACTIONS = ['view_own_request', 'view_profile', 'manage_members', 'invite', 'transfer_admin', 'request_ean_association'] as const;
type OrgAction = (typeof ORG_ACTIONS)[number];

/** Whether Permit has the tenant. Permit SDK: api.tenants.get(key), which answers 404 (`PermitApiError.status`) for one that does not exist. */
export async function tenantExists(d: Deps, key: string): Promise<boolean> {
  try {
    await d.permitApi.tenants.get(key);
    return true;
  } catch (e) {
    if (statusOf(e) === 404) return false;
    throw e;
  }
}

/** The three facts Great Eagle's trust service owns, and nothing else from its answer. */
export function trustFacts(f: TrustFacts): TrustFacts {
  return { identity_verified: f.identity_verified, duplicate_check: f.duplicate_check, risk_state: f.risk_state };
}

/** "Riders of Rohan" → "riders-of-rohan": lowercase, every run of non-alphanumerics becomes one dash. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function membersOf(assignments: ReadonlyArray<{ user: string; role: string }>): Array<{ user: string; roles: string[] }> {
  const roles = new Map<string, string[]>();
  for (const a of assignments) roles.set(a.user, [...(roles.get(a.user) ?? []), a.role]);
  return [...roles].map(([user, held]) => ({ user, roles: held }));
}

/** S1: progressive onboarding, organization association and the first admin. */
export function s1Router(d: Deps): Router {
  const r = Router();

  const orgRef = (key: string): ResourceRef => ({ type: RESOURCE.organization, key, tenant: key });
  const targetOf = (key: string) => `${RESOURCE.organization}:${key}`;
  const orgName = async (key: string): Promise<string> =>
    (await d.mock.getOrg(key))?.name ?? d.seed.organizations.find((o) => o.key === key)?.name ?? key;
  // How S1's routes ask Permit: `await enforce(res, action, resource)`, one line per action. It takes the persona from
  // the request, and a deny stops the request with 403. Underneath, enforcer.ts adds the time and calls permit.check.
  const enforce = async (res: Response, action: string, ref: ResourceRef) => {
    if (!(await d.enforcer.check(personaOf(res), action, ref, { source: sourceOf(res) }))) throw deniedBy(action, ref);
  };

  /**
   * An existing tenant is resumed only as this persona's own unfinished creation: a retry after a 424 left it with no
   * first-admin request yet, and nobody else holds a role in it. Anything else already exists, including another
   * persona's organization, which a creation must never join.
   */
  const resumable = async (key: string, persona: string): Promise<boolean> => {
    const [firstAdmin, assignments] = await Promise.all([
      d.mock.listRequests({ tenant: key, type: 'first_admin' }),
      // Permit read: who holds which role in the tenant.
      d.permitApi.roleAssignments.list({ tenant: key }),
    ]);
    return firstAdmin.length === 0 && assignments.every((a) => a.user === persona);
  };

  r.post('/s1/organizations', async (req, res) => {
    const persona = personaOf(res);
    const name = text(bodyOf(req), 'name');
    const key = slugify(name);
    if (key === '') throw new HttpError(400, 'name needs at least one letter or digit');
    if ((await tenantExists(d, key)) && !(await resumable(key, persona))) throw new HttpError(409, `${name} already exists`);
    // Every step is safe to repeat, so a retry after a 424 completes the creation where it stopped (F1).
    const facts = await d.mock.getUserFacts(persona);
    // Permit write: the trust facts Great Eagle holds on the creator, as the user's attributes.
    if (facts) await d.facts.update(persona, 'trust facts from Great Eagle', (a) => ({ ...a, ...trustFacts(facts) }));
    const org = await d.mock.createOrg(key, name);
    // Permit write: the organization's tenant (api.tenants.create), which scopes its roles and resources.
    await resumableWrite(d.events, `create tenant ${key}`, 409, () => d.permitApi.tenants.create({ key, name }));
    // Permit write: the organization as a resource in that tenant (api.resourceInstances.create), with Great Eagle's
    // ownership fact as its ownership_verified attribute.
    await resumableWrite(d.events, `create ${targetOf(key)}`, 409, () =>
      d.permitApi.resourceInstances.create({ key, resource: RESOURCE.organization, tenant: key, attributes: { id: key, ownership_verified: org.ownership_verified === true } }));
    // Permit write: the creator gets pending_member in the new tenant.
    await ensureRole(d, persona, ROLE.pendingMember, key);
    const request = await d.mock.createRequest({
      type: 'first_admin', tenant: key, target: targetOf(key), role: ROLE.orgAdmin, requested_for: persona, initiated_by: persona, org_name: org.name,
    });
    res.status(201).json({ org, request });
  });

  r.get('/s1/organizations/:key', async (req, res) => {
    const persona = personaOf(res);
    const key = req.params.key;
    if (!(await tenantExists(d, key))) throw new HttpError(404, 'Organization not found');
    const ref = orgRef(key);
    const [decisions, assignments, eanInstances, org, facts, requests] = await Promise.all([
      // Permit check, six at once: which organization actions may this persona take? The page is built from the answers.
      d.enforcer.bulk(persona, ORG_ACTIONS.map((action) => ({ action, ref })), { source: sourceOf(res) }),
      // Permit read, for display: the tenant's members and its EANs.
      d.permitApi.roleAssignments.list({ tenant: key }),
      d.permitApi.resourceInstances.list({ tenant: key, resource: RESOURCE.ean }),
      d.mock.getOrg(key),
      d.mock.getUserFacts(persona),
      d.mock.listRequests({ tenant: key }),
    ]);
    const can = Object.fromEntries(ORG_ACTIONS.map((action, i) => [action, decisions[i] === true])) as Record<OrgAction, boolean>;
    const eans = eanInstances.map((i) => ({ type: RESOURCE.ean, key: i.key, tenant: key }));
    // Permit check over a list: keep only the EANs this persona may view.
    const visible = new Set((await d.enforcer.filter(persona, 'view', eans, { source: sourceOf(res) })).map((e) => e.key));
    res.json({
      org: org ?? { key, name: await orgName(key), ownership_verified: false },
      can,
      facts: { user: facts ? trustFacts(facts) : null, ownership_verified: org?.ownership_verified === true },
      members: membersOf(assignments),
      eans: eans.map((e) => ({ key: e.key, visible: visible.has(e.key) })),
      requests,
    });
  });

  r.get('/s1/reviewer-queue', async (_req, res) => {
    const persona = personaOf(res);
    // Permit check: may this persona review the onboarding queue?
    await enforce(res, 'review', QUEUE_REF);
    const pending = await d.mock.listRequests({ status: 'pending', type: 'first_admin' });
    const requests = await Promise.all(pending.map(async (request) => {
      const [facts, org] = await Promise.all([d.mock.getUserFacts(request.requested_for), d.mock.getOrg(request.tenant)]);
      return { request, facts: facts ? trustFacts(facts) : null, ownership_verified: org?.ownership_verified === true };
    }));
    res.json({ requests });
  });

  r.post('/s1/organizations/:key/ean-associations', async (req, res) => {
    const persona = personaOf(res);
    const key = req.params.key;
    const body = bodyOf(req);
    const ean = text(body, 'ean');
    const proof = text(body, 'proof');
    // Permit check: may this persona link a billing account (EAN) to this organization?
    await enforce(res, 'request_ean_association', orgRef(key));
    // The account master's validation of the proof is the approval (decision 13).
    const result = await d.mock.associateEan(ean, key, proof, persona);
    if (!result.valid) throw new HttpError(422, result.reason || 'The account master did not accept the proof');
    // Permit write: the EAN as a resource in the tenant (api.resourceInstances.create), with association_verified: true,
    // which opens it to the organization's verified admins (the Associated EAN rule).
    const { ms } = await timedWrite(d.events, `create ${RESOURCE.ean}:${ean}`, () =>
      d.permitApi.resourceInstances.create({ key: ean, resource: RESOURCE.ean, tenant: key, attributes: { id: ean, association_verified: true } }));
    res.status(201).json({ ean, ms });
  });

  r.post('/s1/organizations/:key/invitations', async (req, res) => {
    const persona = personaOf(res);
    const key = req.params.key;
    const user = personaKey(bodyOf(req), 'user', d.seed);
    // Permit check: may this persona invite members to this organization?
    await enforce(res, 'invite', orgRef(key));
    const request = await d.mock.createRequest({
      type: 'member_invite', tenant: key, target: targetOf(key), role: ROLE.orgMember, requested_for: user, initiated_by: persona, org_name: await orgName(key),
    });
    res.status(201).json(request);
  });

  r.post('/s1/organizations/:key/admin-transfers', async (req, res) => {
    const persona = personaOf(res);
    const key = req.params.key;
    const body = bodyOf(req);
    const to = personaKey(body, 'to', d.seed);
    const reason = optionalText(body, 'reason');
    // Permit check: may this persona hand the admin role over?
    await enforce(res, 'transfer_admin', orgRef(key));
    const request = await d.mock.createRequest({
      type: 'admin_transfer', tenant: key, target: targetOf(key), role: ROLE.orgAdmin, requested_for: to, initiated_by: persona,
      org_name: await orgName(key), ...(reason === undefined ? {} : { reason }),
    });
    res.status(201).json(request);
  });

  r.post('/s1/organizations/:key/step-down', async (req, res) => {
    const persona = personaOf(res);
    const key = req.params.key;
    // Permit read: who holds org_admin here.
    const assignments = await d.permitApi.roleAssignments.list({ tenant: key });
    const holders = [...new Set(assignments.filter((a) => a.role === ROLE.orgAdmin).map((a) => a.user))];
    const name = await orgName(key);
    if (!holders.includes(persona)) throw new HttpError(403, `${personaName(d.seed, persona)} is not an admin of ${name}.`);
    // The last-admin guard: someone else must still hold admin power that Permit allows right now.
    const ref = orgRef(key);
    // Permit check, per admin: does this holder's manage_members work right now?
    const effective = await effectiveAdmins(holders, (user) => d.enforcer.check(user, 'manage_members', ref, { source: 'guard', label: 'last-admin guard' }));
    if (!effective.some((user) => user !== persona)) throw new HttpError(409, `${name} must keep at least one effective admin.`);
    // Permit write: org_admin out, and org_member in if not held already.
    await unassign(d, persona, ROLE.orgAdmin, key);
    if (!assignments.some((a) => a.user === persona && a.role === ROLE.orgMember)) await assign(d, persona, ROLE.orgMember, key);
    res.json({ ok: true });
  });

  return r;
}
