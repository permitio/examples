import { isDeepStrictEqual } from 'node:util';
import { type Response, Router } from 'express';
import type { Deps } from '#src/server/app';
import { deniedBy, HttpError, permitReason, statusOf } from '#src/server/errors';
import type { DemoEvent } from '#src/server/events';
import type { MockIntegration } from '#src/server/mock-client';
import { type DemoRequest, RESOURCE, ROLE, TENANT } from '#src/server/model';
import type { ResourceRef } from '#src/server/permit/enforcer';
import { ensureInstanceRole, ensureNoInstanceRole } from '#src/server/permit/instance-roles';
import { describeWriteError, WriteFailedError } from '#src/server/permit/writes';
import { isPersona, personaName, personaOf, sourceOf } from '#src/server/personas';
import { type Body, bodyOf, text } from '#src/server/routes/validate';

/** The EAN a connector is registered with: scope to test against, never production. */
export const SANDBOX_EAN = 'EAN-SANDBOX';
const SANDBOX_INSTANCE = `${RESOURCE.ean}:${SANDBOX_EAN}`;

/** The attributes that make a Permit user a connector: a non-human principal, its owner, and the customer it acts for. */
export function connectorMarks(owner: string, customer: string): { principal_type: 'integration'; owner: string; customer: string } {
  return { principal_type: 'integration', owner, customer };
}

/** Whether a Permit user's attributes mark it as a connector acting for `customer`. Both marks are needed. */
export function actsFor(attributes: unknown, customer: string): boolean {
  if (typeof attributes !== 'object' || attributes === null) return false;
  const { principal_type: type, customer: actsForCustomer } = attributes as Record<string, unknown>;
  return type === 'integration' && actsForCustomer === customer;
}

/** The same key pattern as Great Eagle's systems' registry. The key is also the connector's user in Permit. */
const INTEGRATION_KEY = /^[a-z0-9-]{3,40}$/;
const EAN_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 80;
const MAX_REASON = 500;
/** How many of a connector's calls its card lists. */
const RECENT_CALLS = 10;

/** An EAN key as given: exactly the shape Great Eagle's systems and Permit use, so nothing odd reaches a check or a write. */
export function eanKeyOf(value: unknown): string {
  if (typeof value !== 'string' || !EAN_KEY.test(value)) throw new HttpError(400, 'ean must be an EAN key such as EAN-1001');
  return value;
}

/** A required text field of at most `max` characters, trimmed. */
function boundedText(body: Body, name: string, max: number): string {
  const value = text(body, name);
  if (value.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return value;
}

/** One call a connector made, as the portal recorded its check: what it asked, about what, Permit's answer and when (epoch ms). */
interface RecentCall { action: string; resource: string; allow: boolean; at: number }

/**
 * A connector as the pages show it: who it is, who owns it, the organization it acts for (its tenant key, and its name for the
 * screen), the roles Permit holds for it now, the requests made for it and its latest calls.
 */
interface IntegrationView {
  key: string; name: string; owner: string; customer: string; customer_name: string;
  scope: Array<{ role: string; resource: string }>;
  requests: DemoRequest[];
  recent: RecentCall[];
}

/**
 * S5, an integration acting for a customer: registering the connector, its production request and its scope,
 * under /api/s5. A persona route: app.ts mounts it behind the persona middleware. The connector's own calls are in the
 * integration API (integration-api.ts); its client secret is Great Eagle's systems' to keep, and answered only here, once,
 * at registration.
 */
export function s5Router(d: Deps): Router {
  const r = Router();

  const organization: ResourceRef = { type: RESOURCE.organization, key: TENANT.shire, tenant: TENANT.shire };
  // How S5's routes ask Permit: `await enforce(res, action, resource)`, one line per action. It takes the persona from the
  // request, and a deny stops the request with 403. Underneath, enforcer.ts adds the time and calls permit.check.
  const enforce = async (res: Response, action: string, ref: ResourceRef) => {
    if (!(await d.enforcer.check(personaOf(res), action, ref, { source: sourceOf(res) }))) throw deniedBy(action, ref);
  };
  const integrationOf = async (key: string): Promise<MockIntegration> => {
    const found = (await d.mock.listIntegrations()).find((i) => i.key === key);
    if (!found) throw new HttpError(404, `No integration ${key}`);
    return found;
  };
  /** The organization a persona belongs to: the seeded organization named as the persona's company. None for a persona without one. */
  const tenantOf = (persona: string): string | undefined => {
    const company = d.seed.personas.find((p) => p.key === persona)?.company;
    return d.seed.organizations.find((o) => o.name === company)?.key;
  };
  /**
   * The connector's own calls, newest first and at most {@link RECENT_CALLS}, from the portal's record of checks (`events`,
   * oldest first). Only those made since it was registered: a reset clears Great Eagle's registry and not this record, so a
   * connector registered again must not show the last run's calls.
   */
  const recentOf = (i: MockIntegration, events: readonly DemoEvent[]): RecentCall[] => {
    const since = Date.parse(i.created_at);
    const calls = events.flatMap((e) => (e.kind === 'check' && e.user === i.key && e.at >= since ? [{ action: e.action, resource: e.resource, allow: e.allow, at: e.at }] : []));
    return calls.reverse().slice(0, RECENT_CALLS);
  };
  /** The organization's name, for the screen: the seed names each tenant; one it does not name shows as its key. */
  const organizationName = (tenant: string) => d.seed.organizations.find((o) => o.key === tenant)?.name ?? tenant;
  /** The roles `user` holds: in `tenant` when one is named, else in every tenant. A read that fails is a 502, never an empty list. */
  const rolesOf = async (user: string, tenant?: string) => {
    try {
      // Permit read: the user's role assignments (in one tenant when it is named); a role on one resource carries it as `type:key`.
      return await d.permitApi.roleAssignments.list({ user, ...(tenant === undefined ? {} : { tenant }) });
    } catch (e) {
      throw new HttpError(502, `Permit could not list the roles of ${user}: ${permitReason(e)}`);
    }
  };
  /** The roles the connector holds on single resources now, in its customer's tenant: its scope. */
  const scopeOf = async (i: MockIntegration) =>
    (await rolesOf(i.key, i.customer)).flatMap((a) => (a.resource_instance === undefined ? [] : [{ role: a.role, resource: a.resource_instance }]));
  /**
   * Whether `key` is free to become a connector of `persona`'s: Permit has no user with that key (its 404), or the user is the
   * persona's own registration of it that stopped before the credential was issued (a 424 on the sandbox role, say): the
   * connector's marks naming this persona, exactly, and no role but integration_client on the sandbox. Any other user in
   * Permit is someone's identity already, and syncing the key would take it over, roles included. A read that fails is a 502.
   */
  const freeFor = async (key: string, persona: string): Promise<boolean> => {
    let attributes: unknown;
    try {
      // Permit read: the user with this key in Permit's directory, if there is one.
      ({ attributes } = await d.permitApi.users.get(key));
    } catch (e) {
      if (statusOf(e) === 404) return true;
      throw new HttpError(502, `Permit could not say whether ${key} is taken: ${permitReason(e)}`);
    }
    if (!isDeepStrictEqual(attributes, connectorMarks(persona, TENANT.shire))) return false;
    return (await rolesOf(key)).every((a) => a.role === ROLE.integrationClient && a.tenant === TENANT.shire && a.resource_instance === SANDBOX_INSTANCE);
  };

  r.post('/s5/integrations', async (req, res) => {
    const persona = personaOf(res);
    const body = bodyOf(req);
    const key = body['key'];
    if (typeof key !== 'string' || !INTEGRATION_KEY.test(key)) throw new HttpError(400, 'key must be 3 to 40 lowercase letters, digits or dashes');
    const name = boundedText(body, 'name', MAX_NAME);
    // Permit check: may this persona register an integration for the organization?
    await enforce(res, 'register_integration', organization);
    // The connector becomes a Permit user, and syncing replaces a user's attributes and keeps its roles: a key that is a
    // person's, a registered connector's or any other Permit user's is never its key, so registering under it can take
    // nobody over. All are refused before anything is written; Permit's own directory has the last word.
    if (isPersona(d.seed, key) || (await d.mock.listIntegrations()).some((i) => i.key === key) || !(await freeFor(key, persona))) {
      throw new HttpError(409, `${key} is already taken.`);
    }
    // Every step before the credential can be repeated, so a retry after a 424 completes the registration where it stopped:
    // the credential is the one step a retry cannot repeat, and is issued last.
    // Permit write: the connector as a user of its own (api.users.sync), marked as a non-human principal with its owner and
    // customer. Not confirmed on the PDP, and recorded as no event: the role write below is, and shows the PDP knows the user.
    await d.permitApi.users.sync({ key, first_name: name, attributes: connectorMarks(persona, TENANT.shire) })
      .catch((e: unknown) => {
        throw new WriteFailedError(describeWriteError(e), statusOf(e));
      });
    // Permit write: integration_client on the sandbox EAN only. Production scope waits for an approval.
    await ensureInstanceRole(d, key, ROLE.integrationClient, TENANT.shire, SANDBOX_INSTANCE);
    // Great Eagle's systems issue the client credential, and refuse a key a connector already holds with 409.
    const registered = await d.mock.registerIntegration({ key, name, owner: persona, customer: TENANT.shire });
    const integration: IntegrationView = {
      key: registered.key, name: registered.name, owner: registered.owner, customer: registered.customer, customer_name: organizationName(registered.customer),
      scope: [{ role: ROLE.integrationClient, resource: SANDBOX_INSTANCE }], requests: [], recent: [],
    };
    // The one answer that carries the client secret: nothing may keep it.
    res.status(201).set('cache-control', 'no-store').json({ integration, client_secret: registered.client_secret });
  });

  r.post('/s5/integrations/:key/production-requests', async (req, res) => {
    const persona = personaOf(res);
    const body = bodyOf(req);
    const ean = eanKeyOf(body['ean']);
    const reason = boundedText(body, 'reason', MAX_REASON);
    const integration = await integrationOf(req.params.key);
    if (integration.owner !== persona) {
      throw new HttpError(403, `Only ${personaName(d.seed, integration.owner)} can ask for production access for ${integration.name}.`);
    }
    // Permit check: may this persona, the connector's owner, still register integrations for the organization?
    await enforce(res, 'register_integration', organization);
    // Permit read: only an EAN of the customer can be asked for; Sam could never approve any other, and it would wait forever.
    const eans = await d.permitApi.resourceInstances.list({ tenant: integration.customer, resource: RESOURCE.ean });
    if (!eans.some((i) => i.key === ean)) throw new HttpError(404, `${ean} is not an EAN of this organization.`);
    const request = await d.mock.createRequest({
      type: 'integration_access', tenant: integration.customer, target: `${RESOURCE.ean}:${ean}`, role: ROLE.integrationClient,
      requested_for: integration.key, initiated_by: persona, reason,
    });
    res.status(201).json(request);
  });

  r.get('/s5/integrations', async (_req, res) => {
    // A persona sees the integrations that act for their own organization, and no others. One of another organization, or of
    // none, has nothing to list, and nothing is read from Permit for them.
    const tenant = tenantOf(personaOf(res));
    if (tenant === undefined) {
      res.json({ integrations: [] });
      return;
    }
    const [registered, requests] = await Promise.all([
      d.mock.listIntegrations(),
      d.mock.listRequests({ type: 'integration_access', tenant }),
    ]);
    const events = d.events.since(0);
    const views = await Promise.all(registered.filter((i) => i.customer === tenant).map(async (i): Promise<IntegrationView> => ({
      key: i.key, name: i.name, owner: i.owner, customer: i.customer, customer_name: organizationName(i.customer), scope: await scopeOf(i),
      requests: requests.filter((q) => q.requested_for === i.key), recent: recentOf(i, events),
    })));
    res.json({ integrations: views });
  });

  r.post('/s5/integrations/:key/scope', async (req, res) => {
    const persona = personaOf(res);
    const body = bodyOf(req);
    const ean = eanKeyOf(body['ean']);
    const level = body['level'];
    if (level !== 'read' && level !== 'none') throw new HttpError(400, "level must be 'read' or 'none'");
    const integration = await integrationOf(req.params.key);
    const ref: ResourceRef = { type: RESOURCE.ean, key: ean, tenant: integration.customer };
    // Permit check: may this persona approve integrations on this EAN? Changing or ending an approval needs the right that gave it.
    await enforce(res, 'approve_integration', ref);
    const instance = `${RESOURCE.ean}:${ean}`;
    const { key, customer } = integration;
    // The roles the connector holds on that EAN now, as Permit lists them.
    const held = (await scopeOf(integration)).filter((entry) => entry.resource === instance).map((entry) => entry.role);
    if (level === 'read') {
      // View-only swaps the client role for the reader role. It never gives read access the connector does not have: access
      // to an EAN comes from an approved request, which the four-eyes rule guards.
      if (!held.includes(ROLE.integrationClient) && !held.includes(ROLE.integrationReader)) {
        throw new HttpError(409, `${integration.name} has no access on ${ean}, so there is nothing to make view-only: access to an EAN comes from an approved request.`);
      }
      // Permit write: the reader role first, so the connector can view throughout; then the client role goes.
      const added = await ensureInstanceRole(d, key, ROLE.integrationReader, customer, instance);
      res.json({ ms: added + (await ensureNoInstanceRole(d, key, ROLE.integrationClient, customer, instance)) });
      return;
    }
    // Permit write: every role the connector holds on that EAN goes, whatever gave it, the client role first, so every call
    // the connector makes about it is denied.
    const rank = (role: string) => (role === ROLE.integrationClient ? 0 : role === ROLE.integrationReader ? 1 : 2);
    let ms = 0;
    for (const role of [...held].sort((a, b) => rank(a) - rank(b))) ms += await ensureNoInstanceRole(d, key, role, customer, instance);
    // The approval these roles came from is over: the request record says so, as after S4's revocation.
    const approved = await d.mock.listRequests({ tenant: customer, requested_for: key, status: 'approved', type: 'integration_access' });
    for (const q of approved.filter((x) => x.target === instance)) await d.mock.transition(q.id, 'revoked', persona);
    res.json({ ms });
  });

  return r;
}
