import type { ArcjetNodeRequest } from '@arcjet/node';
import type { BotType } from '#src/policy';

export type ClassifierName = 'arcjet' | 'user-agent';

/** What a classifier made of one request. */
export type Classification =
  | { kind: 'caller'; botType: BotType; by: ClassifierName; reason: string }
  | { kind: 'blocked'; by: ClassifierName; reason: string };

/** Decides what kind of caller sent a request. */
export interface Classifier {
  readonly name: ClassifierName;
  /** One line for the startup log. */
  readonly description: string;
  classify(request: ArcjetNodeRequest): Promise<Classification>;
}

/** The request's User-Agent, or undefined when it sent none or an empty one. */
export function userAgentOf(request: ArcjetNodeRequest): string | undefined {
  const header = request.headers?.['user-agent'];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value ? value : undefined;
}

/**
 * The same request with another User-Agent, or with none when `userAgent` is null. The demo page
 * uses it to send a request as each kind of caller, since a browser cannot change its own
 * User-Agent.
 */
export function withUserAgent(
  request: ArcjetNodeRequest,
  userAgent: string | null,
): ArcjetNodeRequest {
  const { 'user-agent': _replaced, ...headers } = request.headers ?? {};
  return {
    headers: userAgent === null ? headers : { ...headers, 'user-agent': userAgent },
    socket: request.socket,
    method: request.method,
    httpVersion: request.httpVersion,
    url: request.url,
  };
}
