import { consolePage } from '#src/console';

/**
 * The three runs the page offers, in order: what each sends to the portal's integration API as the
 * connector.
 */
const RUNS = [
  {
    id: 'create-1001',
    op: 'create',
    ean: 'EAN-1001',
    label: 'Create on EAN-1001',
    call: 'POST /api/integration/shipments',
  },
  {
    id: 'create-1002',
    op: 'create',
    ean: 'EAN-1002',
    label: 'Create on EAN-1002',
    call: 'POST /api/integration/shipments',
  },
  {
    id: 'list-1001',
    op: 'list',
    ean: 'EAN-1001',
    label: 'List on EAN-1001',
    call: 'GET /api/integration/shipments?ean=EAN-1001',
  },
] as const;

const ROWS = RUNS.map(
  (run) => `        <tr data-run="${run.id}" data-op="${run.op}" data-ean="${run.ean}">
          <td><button class="btn" type="button" disabled>${run.label}</button></td>
          <td class="call"><code>${run.call}</code><span>ean ${run.ean}</span></td>
          <td class="answer"><span class="status" aria-live="polite"></span><pre hidden></pre></td>
        </tr>`,
).join('\n');

const MAIN = `  <div id="banner" role="alert"></div>
  <section aria-labelledby="page-title">
    <div class="head">
      <h2 id="page-title">S5, an integration acting for a customer</h2>
      <p class="summary">These systems stand in for the company's OAuth server: they hold the connector's client credential and send it to the portal's integration API, which asks Permit what the connector may do. The credential was shown once, when Pippin registered the connector in the portal.</p>
    </div>
    <div class="connector">
      <label for="connector">Connector</label>
      <span class="select wide"><select id="connector" disabled></select></span>
      <span id="connector-status" class="status" aria-live="polite"></span>
    </div>
    <div class="frame">
      <table class="runs" aria-labelledby="page-title">
        <thead><tr><th scope="col">Run</th><th scope="col">Sent to the portal</th><th scope="col">The portal's answer</th></tr></thead>
        <tbody>
${ROWS}
        </tbody>
      </table>
    </div>
  </section>`;

const STYLE = `
  .connector { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
  .connector label { font-weight: 700; }
  .select.wide { width: min(24rem, 100%); }
  .runs td { vertical-align: top; }
  .runs td:first-child { width: 1%; white-space: nowrap; }
  .runs .call { width: 30%; }
  .runs .call code { display: block; font: 400 0.875rem/1.4286 var(--font-code); overflow-wrap: anywhere; }
  .runs .call span { color: var(--ink-muted); font-size: 0.875rem; line-height: 1.4286; }
  .runs .answer pre {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--rule);
    border-radius: calc(var(--radius) * 0.6);
    background: var(--ground);
    font: 400 0.875rem/1.4286 var(--font-code);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`;

const SCRIPT = `
'use strict';
const byId = (id) => document.getElementById(id);
const PREFERRED = 'shire-erp';
let connectors = [];
let selected = '';
const rows = [...document.querySelectorAll('tr[data-run]')].map((tr) => ({
  op: tr.dataset.op,
  ean: tr.dataset.ean,
  button: tr.querySelector('button'),
  status: tr.querySelector('.status'),
  body: tr.querySelector('pre'),
}));

async function api(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

function failure(result) {
  return new Error((result.data && result.data.error) || 'HTTP ' + result.status);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = kind ? 'status ' + kind : 'status';
}

function banner(text) {
  const el = byId('banner');
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}

// What an earlier run answered no longer applies once the connector, or the list of connectors, has changed.
function clearAnswers() {
  for (const row of rows) {
    setStatus(row.status, '');
    row.body.hidden = true;
  }
}

function renderConnectors(list) {
  const same = list.length === connectors.length && list.every((c, i) => c.key === connectors[i].key && c.name === connectors[i].name);
  connectors = list;
  const select = byId('connector');
  if (!same) {
    select.replaceChildren(...list.map((c) => new Option(c.name + ' (' + c.key + ')', c.key)));
    const keys = list.map((c) => c.key);
    selected = keys.includes(selected) ? selected : keys.includes(PREFERRED) ? PREFERRED : keys[0] || '';
    clearAnswers();
  }
  select.value = selected;
  select.disabled = list.length === 0;
  setStatus(byId('connector-status'), list.length === 0 ? 'No connector is registered yet. Pippin registers one in the portal.' : '');
  for (const row of rows) {
    if (!row.running) row.button.disabled = list.length === 0;
  }
}

// One run: the console asks these systems to call the portal as the connector, and shows the portal's status and body as they came.
async function run(row) {
  if (selected === '' || row.running) return;
  row.running = true;
  row.button.disabled = true;
  row.body.hidden = true;
  setStatus(row.status, 'running…');
  try {
    const result = await api('POST', '/api/integrations/' + encodeURIComponent(selected) + '/run', { op: row.op, ean: row.ean });
    if (!result.ok) throw failure(result);
    const answer = result.data;
    setStatus(row.status, 'HTTP ' + answer.status, answer.status >= 200 && answer.status < 300 ? 'ok' : 'bad');
    row.body.textContent = answer.body === null || answer.body === undefined ? '(no body)' : JSON.stringify(answer.body, null, 2);
    row.body.hidden = false;
  } catch (error) {
    setStatus(row.status, error.message, 'bad');
  } finally {
    row.running = false;
    row.button.disabled = connectors.length === 0;
  }
}

for (const row of rows) row.button.addEventListener('click', () => run(row));
byId('connector').addEventListener('change', () => {
  selected = byId('connector').value;
  clearAnswers();
});

async function refresh() {
  try {
    const result = await api('GET', '/api/integrations');
    if (!result.ok) throw failure(result);
    renderConnectors(result.data);
    banner('');
  } catch (error) {
    banner('Cannot reach the Great Eagle systems mock: ' + error.message);
  }
}

refresh();
setInterval(refresh, 2000);
`;

/**
 * The presenter console's S5 page (GET /s5): runs the connector against the portal's integration
 * API with the credential these systems hold. Create on EAN-1001, create on EAN-1002 and list on
 * EAN-1001, each answered with the portal's status and body as they came.
 */
export function renderS5Console(): string {
  return consolePage({
    page: 's5',
    title: 'S5, integration',
    lead: 'Presenter console for S5: the connector, run with the credential these systems hold.',
    main: MAIN,
    style: STYLE,
    script: SCRIPT,
  });
}
