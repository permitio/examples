import { Router } from 'express';
import type { Deps } from '#src/server/app';
import { HttpError } from '#src/server/errors';
import { removeExpired } from '#src/server/grants';
import { type CollaboratorGrant, RESOURCE, type RequestType } from '#src/server/model';
import { personaName } from '#src/server/personas';
import { tenantExists, trustFacts } from '#src/server/routes/s1';
import { bodyOf, personaKey, text } from '#src/server/routes/validate';

const COLLABORATOR_TYPES: RequestType[] = ['collaborator_invite', 'renewal'];

/**
 * System calls from the Great Eagle systems mock: a trust fact changed, or the cleanup job ran.
 * They carry no persona.
 */
export function internalRouter(d: Deps): Router {
  const r = Router();

  r.post('/facts-changed', async (req, res) => {
    const body = bodyOf(req);
    if (body['subject'] === 'user') {
      const key = personaKey(body, 'key', d.seed);
      const facts = await d.mock.getUserFacts(key);
      // Permit write: Great Eagle's trust facts, as the user's attributes.
      const update = facts
        ? await d.facts.update(key, 'trust facts from Great Eagle', (a) => ({
            ...a,
            ...trustFacts(facts),
          }))
        : undefined;
      res.json(update && !update.skipped ? { ms: update.ms } : { skipped: true });
      return;
    }
    if (body['subject'] !== 'org') throw new HttpError(400, "subject must be 'user' or 'org'");
    const key = text(body, 'key');
    // An organization's facts reach Permit only once S1 has created its tenant; until then Great
    // Eagle keeps them alone.
    const org = (await tenantExists(d, key)) ? await d.mock.getOrg(key) : null;
    // Permit write: the ownership fact, as the organization's attribute.
    const update = org
      ? await d.resourceFacts.update(
          `${RESOURCE.organization}:${key}`,
          'ownership fact from Great Eagle',
          (a) => ({ ...a, ownership_verified: org.ownership_verified === true }),
        )
      : undefined;
    res.json(update && !update.skipped ? { ms: update.ms } : { skipped: true });
  });

  // Housekeeping, not the security control: an expired grant already denies on every check.
  r.post('/cleanup-expired', async (_req, res) => {
    const requests = await d.mock.listRequests({ type: COLLABORATOR_TYPES });
    let removed = 0;
    for (const user of new Set(requests.map((q) => q.requested_for))) {
      let expired: CollaboratorGrant[] = [];
      // Permit write: remove the expired grant entries (housekeeping; the policy already denies
      // them).
      await d.facts.update(user, 'cleanup: remove expired grants', (a) => {
        const result = removeExpired(a, d.clock.now());
        expired = result.removed;
        return expired.length > 0 ? result.attrs : a;
      });
      for (const grant of expired) {
        removed += 1;
        const matching = requests.filter(
          (q) =>
            q.requested_for === user &&
            q.status === 'approved' &&
            q.target === `${RESOURCE.shipment}:${grant.resource}`,
        );
        const note = `${personaName(d.seed, user)}'s access to ${grant.resource} expired at ${new Date(grant.expires).toISOString()}; the cleanup job removed the grant entry.`;
        for (const initiator of new Set(matching.map((q) => q.initiated_by)))
          await d.mock.notify(initiator, note);
        for (const q of matching) await d.mock.transition(q.id, 'expired', 'cleanup-job');
      }
    }
    res.json({ removed });
  });

  return r;
}
