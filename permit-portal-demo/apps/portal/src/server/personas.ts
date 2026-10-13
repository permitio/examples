import type { RequestHandler, Response } from 'express';
import type { EventSource } from '#src/server/events';
import type { SeedData } from '#src/server/model';

/**
 * The demo identity switcher. Every /api request names a seeded persona in `x-demo-persona`; a
 * missing or unknown one is refused, never defaulted. In production the company's CIAM
 * authenticates users; Permit only authorizes.
 */
export function personaMiddleware(seed: SeedData): RequestHandler {
  const known = new Set(seed.personas.map((p) => p.key));
  return (req, res, next) => {
    const persona = req.get('x-demo-persona');
    if (persona === undefined || !known.has(persona)) {
      res.status(401).json({ error: 'Pick a persona' });
      return;
    }
    res.locals['persona'] = persona;
    next();
  };
}

/** The persona key the middleware accepted for this request. */
export function personaOf(res: Response): string {
  const persona: unknown = res.locals['persona'];
  if (typeof persona !== 'string')
    throw new Error('personaOf() used on a route outside the persona middleware');
  return persona;
}

/**
 * A page's background refresh says `x-demo-source: refresh`; anything else is the persona's own
 * action.
 */
export const requestSource: RequestHandler = (req, res, next) => {
  res.locals['source'] = req.get('x-demo-source') === 'refresh' ? 'refresh' : 'action';
  next();
};

/**
 * The source of this request's checks (`requestSource` sets it); a guard inside a flow passes
 * `'guard'` instead.
 */
export function sourceOf(res: Response): EventSource {
  return res.locals['source'] === 'refresh' ? 'refresh' : 'action';
}

export function isPersona(seed: SeedData, key: string): boolean {
  return seed.personas.some((p) => p.key === key);
}

export function personaName(seed: SeedData, key: string): string {
  return seed.personas.find((p) => p.key === key)?.name ?? key;
}
