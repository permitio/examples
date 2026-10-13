import { type Response, Router } from 'express';
import type { Deps } from '#src/server/app';
import { DeniedError, deniedBy, HttpError } from '#src/server/errors';
import { grantsOf, removeGrant } from '#src/server/grants';
import { RESOURCE, type RequestType, type SeedData } from '#src/server/model';
import type { ResourceRef } from '#src/server/permit/enforcer';
import { personaOf, sourceOf } from '#src/server/personas';
import { bodyOf, optionalText, personaKey, positiveInt, text } from '#src/server/routes/validate';

type Shipment = SeedData['shipments'][number];

const DETAIL_ACTIONS = ['view', 'upload_docs', 'invite_collaborator', 'approve_collaborator', 'revoke_collaborator', 'request_renewal'] as const;
type DetailAction = (typeof DETAIL_ACTIONS)[number];
/** The detail page asks whether a 7-day renewal could be requested. */
const RENEWAL_PROBE_DAYS = 7;
const COLLABORATOR_TYPES: RequestType[] = ['collaborator_invite', 'renewal'];

/** S4: an external collaborator's narrow, approved, automatically expiring access to one shipment. */
export function s4Router(d: Deps): Router {
  const r = Router();

  const shipmentOf = (key: string): Shipment => {
    const shipment = d.seed.shipments.find((s) => s.key === key);
    if (!shipment) throw new HttpError(404, `Unknown shipment ${key}`);
    return shipment;
  };
  const refOf = (s: Shipment, attributes?: Record<string, unknown>): ResourceRef => ({ type: RESOURCE.shipment, key: s.key, tenant: s.tenant, ...(attributes ? { attributes } : {}) });
  const targetOf = (s: Shipment) => `${RESOURCE.shipment}:${s.key}`;
  // How S4's routes ask Permit: `await enforce(res, action, resource)`, one line per action. It takes the persona from
  // the request, and a deny stops the request with 403. Underneath, enforcer.ts adds the time and calls permit.check.
  const enforce = async (res: Response, action: string, ref: ResourceRef) => {
    if (!(await d.enforcer.check(personaOf(res), action, ref, { source: sourceOf(res) }))) throw deniedBy(action, ref);
  };

  r.get('/s4/shipments', async (_req, res) => {
    const persona = personaOf(res);
    const [visible, shared] = await Promise.all([
      // Permit check over a list: keep only the shipments this persona may view.
      d.enforcer.filter(persona, 'view', d.seed.shipments.map((s) => ({ ...refOf(s), shipment: s })), { source: sourceOf(res) }),
      d.mock.listRequests({ requested_for: persona, type: COLLABORATOR_TYPES }),
    ]);
    res.json({ shipments: visible.map((v) => v.shipment), shared });
  });

  r.get('/s4/shipments/:key', async (req, res) => {
    const persona = personaOf(res);
    const shipment = shipmentOf(req.params.key);
    const ref = refOf(shipment);
    const [decisions, all] = await Promise.all([
      // Permit check, six at once: which actions may this persona take on this shipment? The chips show the answers.
      d.enforcer.bulk(persona, DETAIL_ACTIONS.map((action) => ({ action, ref: action === 'request_renewal' ? refOf(shipment, { requested_days: RENEWAL_PROBE_DAYS }) : ref })), { source: sourceOf(res) }),
      d.mock.listRequests({ tenant: shipment.tenant, type: COLLABORATOR_TYPES }),
    ]);
    const can = Object.fromEntries(DETAIL_ACTIONS.map((action, i) => [action, decisions[i] === true])) as Record<DetailAction, boolean>;
    const requests = all.filter((q) => q.target === targetOf(shipment));
    const invited = [...new Set(requests.filter((q) => q.type === 'collaborator_invite').map((q) => q.requested_for))];
    const now = d.clock.now();
    const collaborators = (await Promise.all(invited.map(async (user) => {
      // Permit read, for display: the collaborator's grant entries, to show when each one expires.
      const grant = grantsOf((await d.permitApi.users.get(user)).attributes).find((g) => g.resource === shipment.key);
      return grant ? [{ user, expires: grant.expires, renewals_used: grant.renewals_used, active: grant.expires >= now }] : [];
    }))).flat();
    // Documents are shipment content: only a persona Permit lets view the shipment gets them.
    const documents = can.view ? await d.mock.listDocuments(shipment.key) : [];
    res.json({ shipment, can, collaborators, documents, requests });
  });

  r.post('/s4/shipments/:key/invitations', async (req, res) => {
    const persona = personaOf(res);
    const shipment = shipmentOf(req.params.key);
    const body = bodyOf(req);
    const user = personaKey(body, 'user', d.seed);
    const reason = optionalText(body, 'reason');
    // Permit check: may this persona invite a collaborator to this shipment?
    await enforce(res, 'invite_collaborator', refOf(shipment));
    const request = await d.mock.createRequest({
      type: 'collaborator_invite', tenant: shipment.tenant, target: targetOf(shipment), role: 'collaborator',
      requested_for: user, initiated_by: persona, ...(reason === undefined ? {} : { reason }),
    });
    res.status(201).json(request);
  });

  r.post('/s4/shipments/:key/renewals', async (req, res) => {
    const persona = personaOf(res);
    const shipment = shipmentOf(req.params.key);
    const days = positiveInt(bodyOf(req), 'days');
    // Permit check: may this persona ask for this many days? requested_days travels as a resource attribute, and the
    // policy allows at most 30 days and two renewals.
    if (!(await d.enforcer.check(persona, 'request_renewal', refOf(shipment, { requested_days: days }), { source: sourceOf(res) }))) throw new DeniedError('Renewal not allowed by policy');
    const request = await d.mock.createRequest({
      type: 'renewal', tenant: shipment.tenant, target: targetOf(shipment), role: 'collaborator',
      requested_for: persona, initiated_by: persona, requested_days: days,
    });
    res.status(201).json(request);
  });

  r.post('/s4/shipments/:key/revoke', async (req, res) => {
    const persona = personaOf(res);
    const shipment = shipmentOf(req.params.key);
    const user = personaKey(bodyOf(req), 'user', d.seed);
    // Permit check: may this persona revoke a collaborator on this shipment?
    await enforce(res, 'revoke_collaborator', refOf(shipment));
    // Permit write: remove the grant entry from the collaborator's attributes (never a relationship tuple).
    const { ms } = await d.facts.update(user, `revoke ${shipment.key}`, (a) => removeGrant(a, shipment.key));
    const approved = await d.mock.listRequests({ tenant: shipment.tenant, requested_for: user, status: 'approved', type: COLLABORATOR_TYPES });
    for (const q of approved.filter((x) => x.target === targetOf(shipment))) await d.mock.transition(q.id, 'revoked', persona);
    res.json({ ms });
  });

  r.post('/s4/shipments/:key/documents', async (req, res) => {
    const persona = personaOf(res);
    const shipment = shipmentOf(req.params.key);
    const name = text(bodyOf(req), 'name');
    // Permit check: may this persona upload documents to this shipment?
    await enforce(res, 'upload_docs', refOf(shipment));
    res.status(201).json(await d.mock.addDocument(shipment.key, name, persona));
  });

  r.get('/cleanup/status', async (_req, res) => {
    res.json(await d.mock.cleanupStatus());
  });

  return r;
}
