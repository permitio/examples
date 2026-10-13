import { Router } from 'express';
import type { Deps } from '#src/server/app';
import { deniedBy, HttpError, permitReason, statusOf } from '#src/server/errors';
import type { EventSource } from '#src/server/events';
import { grantsOf, renewGrant, upsertGrant } from '#src/server/grants';
import { assertDifferentApprover } from '#src/server/guards';
import { type DemoRequest, QUEUE_KEY, RESOURCE, type RequestType, ROLE, TENANT } from '#src/server/model';
import type { ResourceRef } from '#src/server/permit/enforcer';
import { ensureInstanceRole } from '#src/server/permit/instance-roles';
import { resumableWrite, timedWrite } from '#src/server/permit/writes';
import { personaName, personaOf, sourceOf } from '#src/server/personas';
import { actsFor } from '#src/server/routes/s5';
import { bodyOf, optionalText, positiveInt } from '#src/server/routes/validate';

/** The shortest and longest grant an approver may set (the S4 runner uses 5 s; the longest menu choice is 30 days). */
const MIN_GRANT_MS = 5_000;
const MAX_GRANT_MS = 30 * 86_400_000;

/** How long the approver says a collaborator's access lasts, in milliseconds. */
function grantDuration(body: Record<string, unknown>): number {
  const ms = positiveInt(body, 'durationMs');
  if (ms < MIN_GRANT_MS || ms > MAX_GRANT_MS) throw new HttpError(400, `durationMs must be between ${MIN_GRANT_MS} and ${MAX_GRANT_MS}`);
  return ms;
}

/** Great Eagle's first-admin review queue, where Gandalf's `review` permission lives. */
export const QUEUE_REF: ResourceRef = { type: RESOURCE.onboardingQueue, key: QUEUE_KEY, tenant: TENANT.operator };

/** Types that only their nominee may answer; every other type is decided by a reviewer whom Permit allows. */
const NOMINEE_TYPES: ReadonlySet<RequestType> = new Set(['member_invite', 'admin_transfer']);

/** The resource a request is about, from its `type:key` target. */
export function targetRef(r: DemoRequest): ResourceRef {
  const colon = r.target.indexOf(':');
  if (colon <= 0 || colon === r.target.length - 1) throw new Error(`Request ${r.id} has a malformed target`);
  return { type: r.target.slice(0, colon), key: r.target.slice(colon + 1), tenant: r.tenant };
}

/** Assigns a tenant role (Permit SDK: api.users.assignRole) and answers how long it took until the local PDP held it. */
export async function assign(d: Deps, user: string, role: string, tenant: string): Promise<number> {
  return (await timedWrite(d.events, `assign ${role} to ${user} in ${tenant}`, () => d.permitApi.users.assignRole({ user, role, tenant }))).ms;
}

/** Removes a tenant role (Permit SDK: api.users.unassignRole) and answers how long it took until the local PDP held it. */
export async function unassign(d: Deps, user: string, role: string, tenant: string): Promise<number> {
  return (await timedWrite(d.events, `unassign ${role} from ${user} in ${tenant}`, () => d.permitApi.users.unassignRole({ user, role, tenant }))).ms;
}

/** {@link assign} inside a multi-write flow (Permit SDK: api.users.assignRole): holding the role already (Permit's 409) means a retried step is done. */
export function ensureRole(d: Deps, user: string, role: string, tenant: string): Promise<number> {
  return resumableWrite(d.events, `assign ${role} to ${user} in ${tenant}`, 409, () => d.permitApi.users.assignRole({ user, role, tenant }));
}

/** {@link unassign} inside a multi-write flow (Permit SDK: api.users.unassignRole): no such assignment (Permit's 404) means a retried step is done. */
export function ensureNoRole(d: Deps, user: string, role: string, tenant: string): Promise<number> {
  return resumableWrite(d.events, `unassign ${role} from ${user} in ${tenant}`, 404, () => d.permitApi.users.unassignRole({ user, role, tenant }));
}

/** The Permit permission a reviewer needs to decide a request; undefined for the nominee types. */
function reviewCheck(r: DemoRequest): { action: string; ref: ResourceRef } | undefined {
  switch (r.type) {
    case 'collaborator_invite':
      return { action: 'approve_collaborator', ref: targetRef(r) };
    case 'renewal':
      return { action: 'approve_renewal', ref: targetRef(r) };
    case 'first_admin':
      return { action: 'review', ref: QUEUE_REF };
    case 'integration_access':
      return { action: 'approve_integration', ref: targetRef(r) };
    default:
      return undefined;
  }
}

/** Approve and deny need the same right: separation of duties and Permit for reviewers, identity for nominees. */
async function authorize(d: Deps, r: DemoRequest, persona: string, source: EventSource): Promise<void> {
  const check = reviewCheck(r);
  if (check) {
    // The portal's four-eyes rule first, then the Permit check: may this persona decide this request?
    assertDifferentApprover(r, persona);
    if (!(await d.enforcer.check(persona, check.action, check.ref, { source }))) throw deniedBy(check.action, check.ref);
    return;
  }
  if (!NOMINEE_TYPES.has(r.type)) throw new HttpError(409, `A ${r.type} request is not decided in the portal.`);
  if (persona !== r.requested_for) {
    throw new HttpError(403, `Only ${personaName(d.seed, r.requested_for)} can answer this ${r.type === 'member_invite' ? 'invitation' : 'handover'}.`);
  }
}

async function pendingRequest(d: Deps, id: string, to: 'approved' | 'denied'): Promise<DemoRequest> {
  const r = await d.mock.getRequest(id);
  if (!r) throw new HttpError(404, 'Request not found');
  if (r.status !== 'pending') throw new HttpError(409, `Cannot move a ${r.status} request to ${to}`);
  return r;
}

/**
 * Throws unless Permit's directory marks `user` as a connector acting for `tenant`, the only user integration scope may go to.
 * Great Eagle's systems keep the request records and take writes without authentication, so a record could name a person or
 * another organization's connector; Permit decides who `requested_for` is. A read that fails is a 502, never a yes.
 */
async function assertConnectorOf(d: Deps, user: string, tenant: string): Promise<void> {
  let attributes: unknown;
  try {
    // Permit read: the user the request names, as Permit's directory holds it.
    ({ attributes } = await d.permitApi.users.get(user));
  } catch (e) {
    if (statusOf(e) !== 404) throw new HttpError(502, `Permit could not say who ${user} is: ${permitReason(e)}`);
  }
  if (!actsFor(attributes, tenant)) throw new HttpError(409, `${user} is not an integration of ${tenant} in Permit, so it cannot be given integration scope.`);
}

/**
 * Writes what an approval grants, waited, and answers the total time the PDP took to apply it. The role flows (first
 * admin, member invitation, handover, a connector's production scope) use the ensure* writes: a retry after a 424
 * resumes them where the unconfirmed write left off, instead of failing on work Permit already did.
 */
async function applyApproval(d: Deps, r: DemoRequest, durationMs?: number): Promise<number> {
  const user = r.requested_for;
  switch (r.type) {
    case 'collaborator_invite': {
      const shipment = targetRef(r).key;
      const duration = durationMs ?? r.duration_ms;
      if (duration === undefined || duration <= 0) throw new HttpError(400, 'Choose how long the access lasts.');
      // Permit write: the grant entry, with the expiry the approver chose, on the collaborator's attributes.
      const update = await d.facts.update(user, `grant ${shipment}`, (a) =>
        upsertGrant(a, { resource: shipment, role: 'collaborator', expires: d.clock.now() + duration, renewals_used: 0 }));
      return update.ms;
    }
    case 'renewal': {
      const shipment = targetRef(r).key;
      const days = r.requested_days;
      if (days === undefined || days <= 0) throw new HttpError(409, 'This renewal has no number of days.');
      // Permit write: the renewal moves the grant's expiry and counts one more renewal.
      const update = await d.facts.update(user, `renew ${shipment} by ${days} days`, (a) => {
        if (!grantsOf(a).some((g) => g.resource === shipment)) throw new HttpError(409, `${personaName(d.seed, user)} has no grant on ${shipment} to renew.`);
        return renewGrant(a, shipment, days, d.clock.now());
      });
      return update.ms;
    }
    case 'first_admin': {
      // Permit write: org_admin in, pending_member out.
      const granted = await ensureRole(d, user, ROLE.orgAdmin, r.tenant);
      return granted + (await ensureNoRole(d, user, ROLE.pendingMember, r.tenant));
    }
    case 'member_invite':
      // Permit write: the invitee becomes org_member.
      return ensureRole(d, user, ROLE.orgMember, r.tenant);
    case 'integration_access':
      await assertConnectorOf(d, user, r.tenant);
      // Permit write (S5): integration_client on the requested EAN goes to the connector, `requested_for`, which is its own
      // identity in Permit. Never to the developer who asked: the role is always integration_client, whatever the record says.
      return ensureInstanceRole(d, user, ROLE.integrationClient, r.tenant, r.target);
    case 'admin_transfer': {
      // The new admin must be effective before the old one steps down, so the org is never left without one.
      // Permit write: org_admin for the new admin first.
      const granted = await ensureRole(d, user, ROLE.orgAdmin, r.tenant);
      // Permit check: with the role written, does the new admin's manage_members work?
      const effective = await d.enforcer.check(user, 'manage_members', targetRef(r), { source: 'guard', label: 'handover: is the new admin effective?' });
      if (!effective) {
        await ensureNoRole(d, user, ROLE.orgAdmin, r.tenant);
        throw new HttpError(409, `${personaName(d.seed, user)} is not an effective admin yet: the trust facts are not all satisfied.`);
      }
      // Permit write: only then does the old admin step down to org_member.
      const stepDown = await ensureNoRole(d, r.initiated_by, ROLE.orgAdmin, r.tenant);
      return granted + stepDown + (await ensureRole(d, r.initiated_by, ROLE.orgMember, r.tenant));
    }
    default:
      throw new HttpError(409, `A ${r.type} request is not decided in the portal.`);
  }
}

/** The approval workflow: the records live in the mock, every decision is authorized here. */
export function requestsRouter(d: Deps): Router {
  const r = Router();

  r.get('/approvals', async (_req, res) => {
    const persona = personaOf(res);
    const pending = (await d.mock.listRequests({ status: 'pending' })).filter((q) => q.initiated_by !== persona);
    const reviewable = pending.flatMap((q) => {
      const check = reviewCheck(q);
      return check && q.requested_for !== persona ? [{ id: q.id, check }] : [];
    });
    // Permit check, one per request: which of these may this persona decide? The list shows only those.
    const allowed = await d.enforcer.bulk(persona, reviewable.map((x) => x.check), { source: sourceOf(res) });
    const decidable = new Set(reviewable.filter((_x, i) => allowed[i] === true).map((x) => x.id));
    res.json({ requests: pending.filter((q) => decidable.has(q.id) || (NOMINEE_TYPES.has(q.type) && q.requested_for === persona)) });
  });

  r.post('/requests/:id/approve', async (req, res) => {
    const persona = personaOf(res);
    const body = bodyOf(req);
    const comment = optionalText(body, 'comment');
    const pending = await pendingRequest(d, req.params.id, 'approved');
    await authorize(d, pending, persona, sourceOf(res));
    // The approver sets how long a collaborator's access lasts; the request record keeps it.
    const durationMs = pending.type === 'collaborator_invite' && body['durationMs'] !== undefined ? grantDuration(body) : undefined;
    // A failed write throws here (424 when the PDP did not confirm it), so the request stays pending.
    const ms = await applyApproval(d, pending, durationMs);
    const request = await d.mock.transition(pending.id, 'approved', persona, comment, durationMs);
    res.json({ request, ms });
  });

  r.post('/requests/:id/deny', async (req, res) => {
    const persona = personaOf(res);
    const comment = optionalText(bodyOf(req), 'comment');
    const pending = await pendingRequest(d, req.params.id, 'denied');
    await authorize(d, pending, persona, sourceOf(res));
    // Permit write: a rejected registrant loses pending_member, so every check denies.
    if (pending.type === 'first_admin') await unassign(d, pending.requested_for, ROLE.pendingMember, pending.tenant);
    const request = await d.mock.transition(pending.id, 'denied', persona, comment);
    res.json({ request });
  });

  r.get('/requests', async (req, res) => {
    const tenant = typeof req.query['tenant'] === 'string' && req.query['tenant'] !== '' ? req.query['tenant'] : undefined;
    res.json(await d.mock.listRequests(tenant === undefined ? {} : { tenant }));
  });

  return r;
}
