// The "Where <name> can go" directory above the decision log: one sign per action and resource the persona was
// checked on, drawn from the panel's own feed, so it needs no API call of its own.

import type { CheckEvent, DemoEvent } from '@/types';

/** At most this many signs: the pairs checked most recently. */
export const SIGN_LIMIT = 8;

/** An answer a sign shows, from a run of consecutive checks of its pair that all gave it. */
export interface SignAnswer {
  allow: boolean;
  /** The newest check in the run: the number the sign shows, as the log's entry carries it. */
  id: number;
  /** The first check in the run. It names the sign's face, so the face turns over once per change, not per re-check. */
  since: number;
}

export interface Sign {
  key: string;
  action: string;
  /** As the check recorded it, `type:key`. */
  resource: string;
  /** The newest answer. */
  answer: SignAnswer;
  /** The answer the newest one replaced, while the view still holds it: the face that turns away. */
  previous?: SignAnswer;
}

interface Pair {
  key: string;
  action: string;
  resource: string;
  /** Oldest first; each run holds checks that gave one answer. */
  runs: SignAnswer[];
}

/**
 * One sign for each distinct action and resource `user` was checked on after event `after` (the last "Clear view"),
 * whatever made the check run: a background re-check counts, which is how a sign turns over when a grant expires.
 * Signs keep the order their pairs first appeared in; past `limit`, the pairs checked longest ago are left out.
 */
export function signsOf(events: readonly DemoEvent[], user: string, after: number, limit = SIGN_LIMIT): Sign[] {
  const checks = events
    .filter((e): e is CheckEvent => e.kind === 'check' && e.user === user && e.id > after)
    .sort((a, b) => a.id - b.id);
  const pairs = new Map<string, Pair>();
  for (const check of checks) {
    const key = JSON.stringify([check.action, check.resource]);
    let pair = pairs.get(key);
    if (!pair) {
      pair = { key, action: check.action, resource: check.resource, runs: [] };
      pairs.set(key, pair);
    }
    const run = pair.runs.at(-1);
    if (run?.allow === check.allow) run.id = check.id;
    else pair.runs.push({ allow: check.allow, id: check.id, since: check.id });
  }
  const signs: Sign[] = [];
  for (const { key, action, resource, runs } of pairs.values()) {
    const answer = runs.at(-1);
    const previous = runs.at(-2);
    if (answer) signs.push({ key, action, resource, answer, ...(previous ? { previous } : {}) });
  }
  const kept = new Set(
    [...signs]
      .sort((a, b) => b.answer.id - a.answer.id)
      .slice(0, limit)
      .map((s) => s.key),
  );
  return signs.filter((s) => kept.has(s.key));
}

/** Resources more than one sign is about: those signs lead with their action, so one place never reads two ways. */
export function sharedResources(signs: readonly Sign[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { resource } of signs) {
    if (seen.has(resource)) shared.add(resource);
    seen.add(resource);
  }
  return shared;
}

/** A recorded resource, `type:key`, split at its first colon; one without a type keeps its whole name as the key. */
export function resourceParts(resource: string): { type: string | undefined; key: string } {
  const colon = resource.indexOf(':');
  return colon === -1 ? { type: undefined, key: resource } : { type: resource.slice(0, colon), key: resource.slice(colon + 1) };
}
