import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { DemoClock } from '#src/server/clock';
import type { PortalConfig } from '#src/server/config';
import { DeniedError, HttpError, permitUnreachable } from '#src/server/errors';
import type { EventLog } from '#src/server/events';
import { SelfApprovalError } from '#src/server/guards';
import type { MockClient } from '#src/server/mock-client';
import type { SeedData } from '#src/server/model';
import type { Enforcer } from '#src/server/permit/enforcer';
import type { Explainer } from '#src/server/permit/explainer';
import type { FactsWriter } from '#src/server/permit/facts-writer';
import type { ResourceFactsWriter } from '#src/server/permit/resource-facts-writer';
import { WriteFailedError } from '#src/server/permit/writes';
import { personaMiddleware, requestSource } from '#src/server/personas';
import { integrationApiRouter } from '#src/server/routes/integration-api';
import { internalRouter } from '#src/server/routes/internal';
import { metaRouter } from '#src/server/routes/meta';
import { requestsRouter } from '#src/server/routes/requests';
import { s1Router } from '#src/server/routes/s1';
import { s2Router } from '#src/server/routes/s2';
import { s4Router } from '#src/server/routes/s4';
import { s5Router } from '#src/server/routes/s5';

/**
 * A user as api.users.sync writes it: its name and its whole attribute set, which replaces the
 * stored one.
 */
export interface UserSync {
  key: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  attributes?: object;
}

export interface Deps {
  config: PortalConfig;
  seed: SeedData;
  events: EventLog;
  clock: DemoClock;
  enforcer: Enforcer;
  /** Replays a recorded check against the PDP for Permit's reason, only when the panel asks (F2). */
  explainer: Explainer;
  facts: FactsWriter;
  resourceFacts: ResourceFactsWriter;
  mock: MockClient;
  permitApi: {
    users: {
      get(k: string): Promise<{ attributes?: object | null }>;
      /**
       * A role in a tenant, or on one resource instance (`resource_instance`, `type:key`). Roles on
       * one resource go through ensureInstanceRole.
       */
      assignRole(a: {
        user: string;
        role: string;
        tenant?: string;
        resource_instance?: string;
      }): Promise<unknown>;
      unassignRole(a: {
        user: string;
        role: string;
        tenant: string;
        resource_instance?: string;
      }): Promise<unknown>;
      /**
       * Creates or replaces the user. Not confirmed on the PDP: a role write that follows is (S5's
       * connector).
       */
      sync(u: UserSync): Promise<unknown>;
      /** Deletes the user and its roles. Not confirmed on the PDP. */
      delete(key: string): Promise<unknown>;
    };
    tenants: {
      get(k: string): Promise<unknown>;
      create(t: { key: string; name: string }): Promise<unknown>;
    };
    resourceInstances: {
      create(i: {
        key: string;
        resource: string;
        tenant: string;
        attributes?: object;
      }): Promise<unknown>;
      list(p: {
        tenant?: string;
        resource?: string;
      }): Promise<
        Array<{ key: string; resource: string; tenant: string; attributes?: object | null }>
      >;
    };
    /**
     * Every role assignment that matches; a role on one resource instance carries it as
     * `resource_instance` (`type:key`).
     */
    roleAssignments: {
      list(p: {
        tenant?: string;
        role?: string;
        user?: string;
      }): Promise<
        Array<{ user: string; role: string; tenant: string; resource_instance?: string }>
      >;
    };
  };
}

/**
 * Requests one client address may make in a minute. The demo's own traffic shares one address
 * (Docker shows the host's browser tabs and scenario runners as its gateway): a visible tab polls
 * the decision panel every 0.7 s and its page every 5 to 10 s, and a runner polls as often as every
 * 0.2 s. That peaks near 1,000 a minute; this leaves room for it and still stops a runaway loop.
 */
const REQUESTS_PER_MINUTE = 3_000;

/** Vite's output folder (apps/portal/dist/web). It may not exist yet: the API works without it. */
const WEB_DIR = fileURLToPath(new URL('../../dist/web/', import.meta.url));

/**
 * Which web build this server hands out: a short hash of the built index.html, which names every
 * hashed asset. Undefined while the UI has not been built. Every /api answer carries it in
 * `x-portal-build`, so a tab still running an older build notices the portal was rebuilt and asks
 * to be reloaded.
 */
export function webBuildOf(webDir: string): string | undefined {
  try {
    return createHash('sha256')
      .update(readFileSync(join(webDir, 'index.html')))
      .digest('hex')
      .slice(0, 12);
  } catch {
    return undefined;
  }
}

export function createApp(deps: Deps, webDir: string = WEB_DIR): Express {
  const build = webBuildOf(webDir);
  const announceBuild: RequestHandler = (_req, res, next) => {
    if (build !== undefined) res.set('x-portal-build', build);
    next();
  };
  const app = express();
  app.disable('x-powered-by');
  // In front of every route, the SPA fallback too. One per app, so tests never share counts.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: REQUESTS_PER_MINUTE,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests' },
    }),
  );
  app.use(express.json());
  app.get('/healthz', (_req, res) => {
    res.sendStatus(200);
  });
  app.use('/internal', internalRouter(deps));
  // The connector calls the integration API with its own credential, so it sits before the persona
  // middleware.
  app.use('/api/integration', integrationApiRouter(deps));
  app.use(
    '/api',
    announceBuild,
    personaMiddleware(deps.seed),
    requestSource,
    metaRouter(deps),
    s4Router(deps),
    s1Router(deps),
    requestsRouter(deps),
    s2Router(deps),
    s5Router(deps),
  );
  app.use(['/api', '/internal'], notFound); // the SPA fallback below never answers for these
  app.use(express.static(webDir));
  app.get('/{*page}', spaFallback(webDir));
  app.use(notFound);
  app.use(onError);
  return app;
}

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' });
};

/** Page routes belong to the React app: answer them with index.html when the UI has been built. */
function spaFallback(webDir: string): RequestHandler {
  const index = join(webDir, 'index.html');
  return (_req, res, next) => {
    res.sendFile(index, (error) => {
      if (error && !res.headersSent) next();
    });
  };
}

const onError: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const [status, body] = errorResponse(error);
  // Only the route is logged: an SDK or HTTP error can carry request details, and the API key must
  // never be logged.
  if (status === 500) console.error(`Unexpected error on ${req.method} ${req.path}`);
  res.status(status).json(body);
};

function errorResponse(error: unknown): [number, { error: string; decision?: 'deny' }] {
  if (error instanceof DeniedError) return [403, { error: error.message, decision: 'deny' }];
  if (error instanceof HttpError) return [error.status, { error: error.message }];
  if (error instanceof WriteFailedError)
    return [error.status === 424 ? 424 : 502, { error: error.message }];
  if (error instanceof SelfApprovalError) return [409, { error: error.message }];
  const unreachable = permitUnreachable(error);
  if (unreachable) return [502, { error: unreachable }];
  const parse = bodyParserError(error);
  if (parse) return parse;
  return [500, { error: 'Unexpected error' }];
}

/** express.json() rejects a body it cannot read with a 4xx error whose `type` names the problem. */
function bodyParserError(error: unknown): [number, { error: string }] | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, type } = error as { status?: unknown; type?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500 || typeof type !== 'string')
    return undefined;
  return [
    status,
    {
      error:
        type === 'entity.parse.failed'
          ? 'The request body is not valid JSON'
          : 'The request body could not be read',
    },
  ];
}
