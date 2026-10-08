import { Router } from 'express';
import type { Deps } from '../app';
import { HttpError } from '../errors';
import type { ResourceRef } from '../permit/enforcer';
import { personaOf, sourceOf } from '../personas';
import { bodyOf, positiveInt } from './validate';

const MAX_BULK = 50;

/** Routes every persona uses: the demo's description, the decision-panel feed, the demo clock and live checks. */
export function metaRouter(d: Deps): Router {
  const r = Router();

  r.get('/meta', (_req, res) => {
    res.json({
      profile: d.config.profile,
      permitAppUrl: d.config.permitAppUrl,
      demoClock: { enabled: d.clock.enabled, offsetMs: d.clock.offsetMs() },
      grantDemoDurationMs: d.config.grantDemoDurationMs,
      personas: d.seed.personas,
      shipments: d.seed.shipments,
    });
  });

  r.get('/events', (req, res) => {
    const since = sinceOf(req.query.since);
    res.json({ events: d.events.since(since), lastId: d.events.lastId() });
  });

  // Permit's reason on demand (F2): replay the check's recorded input to the PDP's /allowed, keep the reason on the
  // event, and answer the replay's own decision, which differs from the event's if the stored facts changed since.
  // Only a check has a decision to explain: a write and a read (a list the PDP answered, such as user permissions) do not.
  r.post('/events/:id/explain', async (req, res) => {
    const event = /^\d+$/.test(req.params.id) ? d.events.get(Number(req.params.id)) : undefined;
    if (!event) throw new HttpError(404, 'Unknown event');
    if (event.kind !== 'check') throw new HttpError(409, 'Only checks can be explained');
    const { reason, allow } = await d.explainer.explain(event.input);
    d.events.patch(event.id, { reason });
    res.json({ reason, allow });
  });

  r.post('/clock/advance', (req, res) => {
    d.clock.advance(positiveInt(bodyOf(req), 'ms'));
    res.json({ offsetMs: d.clock.offsetMs() });
  });

  r.post('/clock/reset', (_req, res) => {
    d.clock.reset();
    res.json({ offsetMs: d.clock.offsetMs() });
  });

  r.post('/checks/bulk', async (req, res) => {
    const items = checksOf(bodyOf(req).checks);
    const start = performance.now();
    // Permit check, several at once, asked by the page itself: Aragorn's live checks every 5 seconds.
    const results = await d.enforcer.bulk(personaOf(res), items, { source: sourceOf(res) });
    res.json({ results: results.map((allow) => ({ allow })), ms: performance.now() - start });
  });

  return r;
}

function sinceOf(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, 'since must be a whole number');
  return Number(value);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

function checksOf(value: unknown): Array<{ action: string; ref: ResourceRef }> {
  if (!Array.isArray(value) || value.length > MAX_BULK) throw new HttpError(400, `checks must be a list of at most ${MAX_BULK} checks`);
  return value.map((check: unknown, i) => {
    const resource = isObject(check) ? check.resource : undefined;
    if (!isObject(check) || !isText(check.action) || !isObject(resource) || !isText(resource.type) || !isText(resource.key) || !isText(resource.tenant)) {
      throw new HttpError(400, `checks[${i}] needs an action and a resource with type, key and tenant`);
    }
    if (resource.attributes !== undefined && !isObject(resource.attributes)) throw new HttpError(400, `checks[${i}].resource.attributes must be an object`);
    const ref: ResourceRef = { type: resource.type, key: resource.key, tenant: resource.tenant };
    if (resource.attributes !== undefined) ref.attributes = resource.attributes;
    return { action: check.action, ref };
  });
}
