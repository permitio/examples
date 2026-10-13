import type { Request } from 'express';
import { HttpError } from '#src/server/errors';
import type { SeedData } from '#src/server/model';
import { isPersona } from '#src/server/personas';

export type Body = Record<string, unknown>;

/** The JSON body as an object; a missing or non-object body reads as empty. */
export function bodyOf(req: Request): Body {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : {};
}

/** A required, non-blank text field, trimmed. */
export function text(body: Body, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${name} is required`);
  return value.trim();
}

/** An optional text field, trimmed; blank reads as absent. */
export function optionalText(body: Body, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`);
  return value.trim() === '' ? undefined : value.trim();
}

/** A field naming a seeded persona, such as the user to invite. */
export function personaKey(body: Body, name: string, seed: SeedData): string {
  const key = text(body, name);
  if (!isPersona(seed, key)) throw new HttpError(400, `Unknown user ${key}`);
  return key;
}

export function positiveInt(body: Body, name: string): number {
  const value = body[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, `${name} must be a positive whole number`);
  return value;
}
