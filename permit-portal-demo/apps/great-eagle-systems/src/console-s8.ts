import { consolePage } from '#src/console';

// The page's own sections, style and script. Like the shell's, they live in template literals: no backticks, "${" or
// backslashes in them. The script uses string concatenation, and "…" and "–" as themselves.

const MAIN = `  <div id="banner" role="alert"></div>
  <section class="users" aria-labelledby="users-title">
    <div class="head">
      <h2 id="users-title">Legacy billing app</h2>
      <p class="summary">Its own users table, and its own rule for view billing on a child account: an admin flag, or the account's code or its EAN's in the user's accounts. Next to that rule it asks Permit the same question.</p>
    </div>
    <div class="frame">
      <table class="rows" aria-labelledby="users-title">
        <thead><tr><th scope="col">User</th><th scope="col">Admin flag</th><th scope="col">Accounts</th><th scope="col">Note</th></tr></thead>
        <tbody id="users"></tbody>
      </table>
    </div>
  </section>
  <section class="mapping" aria-labelledby="mapping-title">
    <div class="head">
      <h2 id="mapping-title">Mapping</h2>
      <p class="summary">The domain owner's mapping turns legacy privileges into Permit roles. Validating replays the legacy access log through the legacy rule and through Permit, with one bulk check, and lists where the two disagree. Syncing writes the mapping's roles to Permit. It never removes a role, so it would give back one that was revoked in Permit.</p>
    </div>
    <dl class="facts">
      <div><dt>Mapping in use</dt><dd id="mapping-version">–</dd></div>
      <div><dt>Validations run</dt><dd id="validations">–</dd></div>
    </dl>
    <div class="actions">
      <button id="validate" class="btn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>Validate mapping</button>
      <button id="use-v2" class="btn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>Use mapping v2 and sync</button>
      <span id="mapping-status" class="status" aria-live="polite"></span>
    </div>
    <div id="sync-result"></div>
    <div id="validation"></div>
  </section>
  <section class="mode" aria-labelledby="mode-title">
    <div class="head">
      <h2 id="mode-title">Who decides</h2>
      <p class="summary">Shadow: the legacy rule decides and Permit's answer is recorded. Both: each must allow, so a revocation in either takes effect at once, and a Permit that cannot answer is a no. Permit: Permit decides and the legacy answer is recorded. Switching back to both is the rollback.</p>
    </div>
    <div class="actions">
      <span id="mode" class="segmented" role="radiogroup" aria-label="Mode"></span>
      <span id="mode-status" class="status" aria-live="polite"></span>
    </div>
  </section>
  <section class="try" aria-labelledby="try-title">
    <div class="head">
      <h2 id="try-title">Try a request</h2>
      <p class="summary">A user asks the legacy app to view billing on a child account. It shows what each side says and what the current mode enforces.</p>
    </div>
    <div class="actions picks">
      <label class="field"><span>User</span><span class="select wide"><select id="try-user"></select></span></label>
      <label class="field"><span>Account</span><span class="select wide"><select id="try-account"></select></span></label>
      <button id="try-send" class="btn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>Send request</button>
    </div>
    <span id="try-status" class="status" aria-live="polite"></span>
    <div id="try-result"></div>
  </section>
  <section class="recent" aria-labelledby="recent-title">
    <div class="head">
      <h2 id="recent-title">Recent decisions</h2>
      <p class="summary">The last 20 requests, newest first. A reset of these systems clears the list.</p>
    </div>
    <div class="frame">
      <table class="rows" aria-labelledby="recent-title">
        <thead><tr><th scope="col">Time</th><th scope="col">User</th><th scope="col">Account</th><th scope="col">Legacy rule</th><th scope="col">Permit</th><th scope="col">Enforced</th><th scope="col">Mode</th></tr></thead>
        <tbody id="recent"></tbody>
      </table>
    </div>
  </section>`;

const STYLE = `
  /* The page's sections: the story runs down it (the table, the mapping, who decides, a request), two small ones side by side from 64rem. */
  h3 { margin: 0; font-size: 1rem; font-weight: 800; line-height: 1.5; }
  @media (min-width: 64rem) {
    main { grid-template-columns: repeat(12, minmax(0, 1fr)); }
    .users, .mapping, .recent { grid-column: 1 / -1; }
    .mode, .try { grid-column: span 6; }
  }
  .rows td { font-size: 0.875rem; }
  .rows td.empty { color: var(--ink-muted); }
  .rows td.count { font-family: var(--font-code); }
  .actions.picks { align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 0.25rem; color: var(--ink-muted); font-size: 0.875rem; }
  .select.wide { width: 15rem; max-width: 100%; }
  #validation, #sync-result, #try-result { display: flex; flex-direction: column; gap: 1rem; }
  #validation:empty, #sync-result:empty, #try-result:empty { display: none; }

  /* An answer is a word in a frame, never a colour alone: a deny is filled, and no answer is dashed. */
  .verdict {
    display: inline-block;
    min-width: 4.5rem;
    padding: 0 0.5rem;
    border: 1px solid var(--control-edge);
    border-radius: calc(var(--radius) * 0.6);
    font: 600 0.8125rem/1.5 var(--font-code);
    text-align: center;
    white-space: nowrap;
  }
  .verdict.deny { border-color: var(--ink); background: var(--ink); color: var(--ground); }
  .verdict.unknown { border-style: dashed; color: var(--ink-muted); }
  .tag {
    display: inline-block;
    margin-right: 0.5rem;
    padding: 0 0.5rem;
    border: 1px solid var(--rule);
    border-radius: calc(var(--radius) * 0.6);
    font: 600 0.75rem/1.6 var(--font-code);
    white-space: nowrap;
  }
  .tag.unexpected { border-color: var(--ink); background: var(--ink); color: var(--ground); }
  .why { max-width: 60ch; }
`;

const SCRIPT = `
'use strict';
const byId = (id) => document.getElementById(id);
const MODES = ['shadow', 'both', 'permit'];
const MODE_TEXT = {
  shadow: 'the legacy rule decides and Permit is recorded',
  both: 'each must allow',
  permit: 'Permit decides and the legacy rule is recorded',
};
const SYNC_WORDS = { written: 'written', unchanged: 'already in Permit', skipped: 'skipped', failed: 'failed' };
let state = null;
// Changes in flight: polling leaves their controls alone until the app has answered.
const pending = new Set();

async function api(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((data && data.error) || 'HTTP ' + response.status);
    error.data = data;
    throw error;
  }
  return data;
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function cells(...values) {
  return el('tr', null, ...values.map((value) => el('td', null, value)));
}

function table(headers, rows) {
  const head = el('tr', null, ...headers.map((header) => {
    const th = el('th', null, header);
    th.scope = 'col';
    return th;
  }));
  return el('div', 'frame', el('table', 'rows', el('thead', null, head), el('tbody', null, ...rows)));
}

function facts(pairs) {
  return el('dl', 'facts', ...pairs.map(([label, value]) => el('div', null, el('dt', null, label), el('dd', null, value))));
}

function setStatus(node, message, kind) {
  node.textContent = message;
  node.className = kind ? 'status ' + kind : 'status';
}

function banner(message) {
  const node = byId('banner');
  node.textContent = message || '';
  node.style.display = message ? 'block' : 'none';
}

function nameOf(key) {
  const user = state && state.users.find((u) => u.key === key);
  return user ? user.name : key;
}

function accountLabel(key) {
  const account = state && state.accounts.find((a) => a.key === key);
  return account ? key + ' (' + account.name + ')' : key;
}

// An answer: allow, deny, or null for no answer from Permit.
function verdict(value) {
  if (value === null || value === undefined) return el('span', 'verdict unknown', 'could not check');
  return value ? el('span', 'verdict allow', 'allow') : el('span', 'verdict deny', 'deny');
}

function person(key) {
  return el('div', 'who', el('div', 'name', nameOf(key), el('small', null, key)));
}

function renderUsers() {
  byId('users').replaceChildren(...state.users.map((user) =>
    cells(person(user.key), user.is_admin ? 'yes' : 'no', user.accounts.length > 0 ? user.accounts.join(', ') : 'none', user.note)));
}

function fillPickers() {
  const users = byId('try-user');
  const accounts = byId('try-account');
  if (users.options.length === 0) for (const user of state.users) users.append(new Option(user.name + ' (' + user.key + ')', user.key));
  if (accounts.options.length === 0) for (const account of state.accounts) accounts.append(new Option(account.key + ' (' + account.name + ')', account.key));
}

function renderMode() {
  if (pending.has('mode')) return;
  for (const radio of byId('mode').querySelectorAll('input')) radio.checked = radio.value === state.mode;
}

function renderFacts() {
  byId('mapping-version').textContent = 'v' + state.mappingVersion;
  byId('validations').textContent = String(state.validations);
}

function renderRecent() {
  const body = byId('recent');
  if (state.recent.length === 0) {
    const empty = el('td', 'empty', 'No requests yet.');
    empty.colSpan = 7;
    body.replaceChildren(el('tr', null, empty));
    return;
  }
  body.replaceChildren(...state.recent.map((d) =>
    cells(new Date(d.at).toLocaleTimeString(), nameOf(d.user), accountLabel(d.account), verdict(d.legacy), verdict(d.permit), verdict(d.enforced), d.mode)));
}

// Why a mismatch no owner approved is there, from the rows behind it and the mapping in use.
function unexpectedReason(userKey, mismatches) {
  const user = state.users.find((u) => u.key === userKey);
  const childCodes = user ? user.accounts.filter((code) => state.accounts.some((a) => a.key === code)) : [];
  const tightening = mismatches.every((row) => row.legacy && !row.permit);
  if (tightening && childCodes.length > 0 && state.mapping.child_account_codes === null) {
    return 'The mapping has no line for child-account codes, and the accounts of ' + nameOf(userKey) + ' hold ' + childCodes.join(', ') + '.';
  }
  if (tightening) return 'The legacy app allows and Permit denies, and no approved tightening covers it.';
  if (mismatches.every((row) => !row.legacy && row.permit)) return 'Permit allows and the legacy app denies: Permit gives more than the legacy rule did.';
  return 'The two sides disagree in both directions.';
}

function groupRow(group, rows) {
  const mismatches = rows.filter((row) => row.user === group.user && row.outcome === 'mismatch');
  const why = group.expected
    ? el('div', 'why', el('span', 'tag', 'Expected tightening'), group.expected.reason + '. Approved by ' + nameOf(group.expected.approved_by) + '.')
    : el('div', 'why', el('span', 'tag unexpected', 'Unexpected'), unexpectedReason(group.user, mismatches));
  const count = el('span', 'count', String(group.count));
  return cells(person(group.user), count, why);
}

// The mismatching rows, one per user and account with how many requests it stands for, in the order of the groups.
function rowsBehind(result) {
  const order = result.summary.groups.map((group) => group.user);
  const pairs = new Map();
  for (const row of result.rows) {
    if (row.outcome !== 'mismatch') continue;
    const key = row.user + ' ' + row.account;
    const pair = pairs.get(key) || { row, count: 0 };
    pair.count += 1;
    pairs.set(key, pair);
  }
  return [...pairs.values()].sort((a, b) => order.indexOf(a.row.user) - order.indexOf(b.row.user));
}

function renderValidation(result) {
  const s = result.summary;
  const parts = [
    el('h3', null, 'Comparison of the two sides'),
    facts([
      ['Requests checked', String(s.total)], ['Match', String(s.matches)], ['Mismatch', String(s.mismatches)], ['Unexpected', String(s.unexpected)],
      ['Could not check', String(s.could_not_check)],
    ]),
  ];
  if (s.could_not_check > 0) {
    const reason = result.error ? ': ' + result.error : '';
    parts.push(el('p', 'status bad', 'Permit could not answer for ' + s.could_not_check + ' of ' + s.total + ' requests' + reason + '. They are not counted as matches or mismatches.'));
  }
  if (s.groups.length > 0) {
    parts.push(el('h3', null, 'Mismatches by user'));
    parts.push(table(['User', 'Mismatches', 'Status'], s.groups.map((group) => groupRow(group, result.rows))));
    parts.push(el('h3', null, 'Rows behind each group'));
    parts.push(table(['User', 'Account', 'Legacy rule', 'Permit', 'Requests'],
      rowsBehind(result).map(({ row, count }) => cells(person(row.user), accountLabel(row.account), verdict(row.legacy), verdict(row.permit), el('span', 'count', String(count))))));
  } else if (s.could_not_check === 0) {
    parts.push(el('p', 'status ok', 'Every request matches.'));
  }
  byId('validation').replaceChildren(...parts);
}

function renderSync(result, failed) {
  const line = 'Mapping v' + result.version + ': ' + result.written + ' written, ' + result.unchanged + ' already in Permit, ' + result.skipped + ' skipped.';
  const outcome = (grant) => (grant.status === 'skipped' && grant.reason ? 'skipped: ' + grant.reason : SYNC_WORDS[grant.status] || grant.status);
  const rows = result.grants.map((grant) => cells(person(grant.user), grant.role, grant.resource || 'the organization', outcome(grant)));
  byId('sync-result').replaceChildren(el('p', failed ? 'status bad' : 'status ok', line), table(['User', 'Role', 'On', 'Result'], rows));
}

async function validate() {
  const button = byId('validate');
  const status = byId('mapping-status');
  button.disabled = true;
  setStatus(status, 'validating…');
  try {
    const result = await api('POST', '/api/legacy/validate');
    renderValidation(result);
    const nothing = result.summary.could_not_check === result.summary.total;
    setStatus(status, nothing ? 'Permit could not answer: nothing was checked' : 'Validated ' + result.summary.total + ' requests', nothing ? 'bad' : 'ok');
  } catch (error) {
    setStatus(status, error.message, 'bad');
  } finally {
    button.disabled = false;
    refresh();
  }
}

async function useV2() {
  const button = byId('use-v2');
  const status = byId('mapping-status');
  button.disabled = true;
  setStatus(status, 'syncing…');
  try {
    await api('PUT', '/api/legacy/mapping', { version: 2 });
    const result = await api('POST', '/api/legacy/sync');
    renderSync(result, false);
    // The comparison above was made before this sync.
    byId('validation').replaceChildren();
    setStatus(status, 'Mapping v2 is in Permit. Validate again to compare.', 'ok');
  } catch (error) {
    if (error.data && error.data.grants) renderSync(error.data, true);
    setStatus(status, error.message, 'bad');
  } finally {
    button.disabled = false;
    refresh();
  }
}

async function setMode(mode) {
  const status = byId('mode-status');
  pending.add('mode');
  setStatus(status, 'switching…');
  try {
    await api('PUT', '/api/legacy/mode', { mode });
    setStatus(status, 'Now ' + mode + ': ' + MODE_TEXT[mode] + '.', 'ok');
  } catch (error) {
    setStatus(status, error.message, 'bad');
  } finally {
    pending.delete('mode');
    refresh();
  }
}

async function trySend() {
  const button = byId('try-send');
  const status = byId('try-status');
  button.disabled = true;
  setStatus(status, 'asking…');
  try {
    const result = await api('POST', '/api/legacy/requests', { user: byId('try-user').value, account: byId('try-account').value });
    byId('try-result').replaceChildren(facts([['Legacy rule', verdict(result.legacy)], ['Permit', verdict(result.permit)], ['Enforced', verdict(result.enforced)], ['Mode', result.mode]]));
    if (result.error) setStatus(status, 'Permit could not answer: ' + result.error, 'bad');
    else setStatus(status, '');
  } catch (error) {
    setStatus(status, error.message, 'bad');
  } finally {
    button.disabled = false;
    refresh();
  }
}

async function refresh() {
  try {
    state = await api('GET', '/api/legacy/state');
    renderUsers();
    fillPickers();
    renderMode();
    renderFacts();
    renderRecent();
    banner('');
  } catch (error) {
    banner('Cannot reach the legacy billing app: ' + error.message);
  }
}

for (const mode of MODES) {
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'mode';
  radio.value = mode;
  radio.addEventListener('change', () => setMode(mode));
  byId('mode').append(el('label', null, radio, el('span', null, mode)));
}
byId('validate').addEventListener('click', validate);
byId('use-v2').addEventListener('click', useV2);
byId('try-send').addEventListener('click', trySend);
refresh();
setInterval(refresh, 2000);
`;

/**
 * The presenter console's S8 page (GET /s8): the legacy billing app, with its users table, the mapping validation and
 * sync, the mode switch, a request to try and the latest decisions. It drives only /api/legacy/….
 */
export function renderS8Console(): string {
  return consolePage({
    page: 's8',
    title: 'S8, migration',
    lead: 'Presenter console for S8: the legacy billing app as it moves to Permit.',
    main: MAIN,
    style: STYLE,
    script: SCRIPT,
  });
}
