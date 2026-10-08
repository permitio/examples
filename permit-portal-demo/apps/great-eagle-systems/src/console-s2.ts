import { Router } from 'express';
import { consolePage } from './console';

/**
 * The grant S2's tester forges: Frodo administers EAN-1001 only, and gives Merry shipper on EAN-1002,
 * which is outside Frodo's scope. It is fixed: the tester sends this grant and nothing a caller could choose.
 */
const FORGED_AS = 'frodo';
const FORGED_GRANT = { user: 'merry', role: 'shipper', resource: 'ean:EAN-1002' } as const;
/** The portal's grants API, which the tester calls, and the route of these systems that the page calls. */
const PORTAL_GRANTS_PATH = '/api/s2/grants';
const TESTER_PATH = '/api/s2/forged-grant';
/** A grant the portal accepts waits up to 5 s for the PDP; a refused one answers at once. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Why a fetch to the portal failed: a timeout, or the socket error behind undici's generic "fetch failed". */
function reasonOf(error: unknown, timeoutMs: number): string {
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return `no answer within ${timeoutMs} ms`;
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const { code, message } = (cause ?? {}) as { code?: unknown; message?: unknown };
  if (typeof message === 'string' && message !== '') return message;
  return typeof code === 'string' ? code : String(error);
}

/**
 * S2's API tester, "Send a grant as Frodo": POST /api/s2/forged-grant sends the forged grant to the portal's grants API
 * as Frodo (`x-demo-persona: frodo`) and answers `{ status, body }`, the portal's own answer verbatim, for the page to
 * show; a portal that does not answer is a 502 `{ error }`. It runs here, on the server side, because the portal has no
 * CORS: a browser page on this origin could not call it with that header. It takes no input, so it cannot be used to send
 * any other grant. app.ts mounts it at the root.
 */
export function s2ConsoleRouter({ portalUrl, timeoutMs = DEFAULT_TIMEOUT_MS }: { portalUrl: string; timeoutMs?: number }): Router {
  const base = portalUrl.replace(/\/+$/, '');
  const r = Router();
  r.post(TESTER_PATH, async (_req, res) => {
    let status: number;
    let raw: string;
    try {
      const response = await fetch(`${base}${PORTAL_GRANTS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-demo-persona': FORGED_AS },
        body: JSON.stringify(FORGED_GRANT),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      raw = await response.text();
    } catch (error) {
      res.status(502).json({ error: `The portal did not answer: ${reasonOf(error, timeoutMs)}` });
      return;
    }
    let body: unknown = raw;
    try {
      body = raw === '' ? null : JSON.parse(raw);
    } catch {
      // Not JSON (a proxy's error page, say): shown as the text it is.
    }
    res.json({ status, body });
  });
  return r;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_STYLE = `
  /* The portal's answer, in the table's own mono type: it wraps rather than scrolls, so a long reason stays readable. */
  .plain pre { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

/** The page's script lives in a template literal: no backticks, "${" or backslashes in it, so it names the route (TESTER_PATH) itself. */
const PAGE_SCRIPT = `
'use strict';
const byId = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = kind ? 'status ' + kind : 'status';
}

// The page asks these systems, same origin; they send the grant to the portal (the portal has no CORS).
byId('send-grant').addEventListener('click', async () => {
  const button = byId('send-grant');
  const status = byId('send-status');
  button.disabled = true;
  setStatus(status, 'sending…');
  try {
    const response = await fetch('/api/s2/forged-grant', { method: 'POST' });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data.status !== 'number') throw new Error((data && data.error) || 'HTTP ' + response.status);
    byId('answer-status').textContent = 'HTTP ' + data.status;
    byId('answer-body').textContent = typeof data.body === 'string' ? data.body : JSON.stringify(data.body, null, 2);
    byId('answer').hidden = false;
    setStatus(status, 'The portal answered.');
  } catch (error) {
    byId('answer').hidden = true;
    setStatus(status, error.message, 'bad');
  } finally {
    button.disabled = false;
  }
});
`;

/**
 * The presenter console's S2 page (GET /s2): the API tester that sends Frodo's forged grant to the portal,
 * showing the request and then the portal's status and body.
 */
export function renderS2Console(): string {
  return consolePage({
    page: 's2',
    title: 'S2, delegated administration',
    lead: 'Presenter console for S2: requests sent to the portal as a persona, outside its forms.',
    main: `  <section aria-labelledby="forged-title">
    <div class="head">
      <h2 id="forged-title">Send a grant as Frodo</h2>
      <p class="summary">An API tester for the boundary of delegated administration. Team access offers Frodo only EAN-1001 and what sits under it, so this sends the grant the form never would, straight to the portal's API: Frodo gives Merry the shipper role on EAN-1002. The portal asks Permit before it writes anything, and the answer below is the portal's own.</p>
    </div>
    <div class="frame">
      <table class="plain" aria-labelledby="forged-title">
        <tbody>
          <tr><td>Request</td><td>POST ${PORTAL_GRANTS_PATH}</td></tr>
          <tr><td>As</td><td>x-demo-persona: ${FORGED_AS}</td></tr>
          <tr><td>Body</td><td>${escapeHtml(JSON.stringify(FORGED_GRANT))}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="actions">
      <button id="send-grant" class="btn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>Send the grant</button>
      <span id="send-status" class="status" aria-live="polite"></span>
    </div>
    <div id="answer" class="frame" hidden>
      <table class="plain" aria-label="The portal's answer">
        <tbody>
          <tr><td>Status</td><td id="answer-status"></td></tr>
          <tr><td>Body</td><td><pre id="answer-body"></pre></td></tr>
        </tbody>
      </table>
    </div>
  </section>`,
    style: PAGE_STYLE,
    script: PAGE_SCRIPT,
  });
}
