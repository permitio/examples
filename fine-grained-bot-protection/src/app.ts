import express, { type ErrorRequestHandler, type Express } from 'express';
import { decide, type ItemDecision, PdpError, type PermitChecker } from '#src/authorize';
import { type Classification, type Classifier, userAgentOf, withUserAgent } from '#src/classifier';
import { renderPage } from '#src/page';
import { findPersona, PERSONAS } from '#src/personas';
import { userSetFor } from '#src/policy';

export interface AppDeps {
  classifier: Classifier;
  permit: PermitChecker;
}

/** How the caller was classified, as the API reports it. */
function callerJson(userAgent: string | undefined, classification: Classification) {
  return {
    userAgent: userAgent ?? null,
    classifiedBy: classification.by,
    reason: classification.reason,
    ...(classification.kind === 'caller'
      ? { botType: classification.botType, userSet: userSetFor(classification.botType) }
      : { blocked: true }),
  };
}

export function createApp({ classifier, permit }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // The items the caller may read, after Arcjet (or the User-Agent check) has said what kind of
  // caller it is.
  app.get('/api/items', async (req, res) => {
    const classification = await classifier.classify(req);
    const caller = callerJson(userAgentOf(req), classification);
    if (classification.kind === 'blocked') {
      res.status(403).json({ error: classification.reason, caller });
      return;
    }
    const decisions = await decide(permit, classification.botType);
    res.json({ caller, items: decisions.filter((d) => d.allowed.read).map((d) => d.item) });
  });

  // The demo page. `?as=<persona>` sends the request with that persona's User-Agent instead of the
  // browser's own.
  app.get('/', async (req, res) => {
    const as = req.query['as'];
    const persona = typeof as === 'string' ? findPersona(as) : undefined;
    if (as !== undefined && persona === undefined) {
      const keys = PERSONAS.map((p) => p.key).join(', ');
      res.status(400).type('text/plain').send(`Unknown persona. Use one of: ${keys}.`);
      return;
    }
    const request = persona === undefined ? req : withUserAgent(req, persona.userAgent);
    const classification = await classifier.classify(request);
    let decisions: ItemDecision[] | undefined;
    let error: string | undefined;
    let status = classification.kind === 'blocked' ? 403 : 200;
    if (classification.kind === 'caller') {
      try {
        decisions = await decide(permit, classification.botType);
      } catch (err) {
        if (!(err instanceof PdpError)) throw err;
        console.error(err.message);
        error = err.message;
        status = 502;
      }
    }
    const page = renderPage({
      classifier: classifier.name,
      personaKey: persona?.key,
      userAgent: userAgentOf(request),
      classification,
      decisions,
      error,
    });
    res.status(status).type('html').send(page);
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof PdpError) {
      console.error(err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Internal error' });
  };
  app.use(onError);
  return app;
}
