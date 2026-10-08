// The presenter console: self-contained pages (inline CSS and JS; only the web fonts come from elsewhere), each driving
// only this service's own API. GET / is the main console; GET /s2, /s5 and /s8 are the scenario pages (console-s2.ts,
// console-s5.ts, console-s8.ts). Every page is built with consolePage(), so they all wear the Great Eagle systems
// surface and one header, whose links lead from page to page: the night concourse by default,
// with a CSS-only switch in the header for the light one. The inline scripts and stylesheets avoid backticks, "${" and
// backslashes, since they live in template literals.

const BRAND = 'Great Eagle systems (simulated)';

/** The console's pages, in the header's order. */
export const CONSOLE_PAGES = [
  { page: 'console', href: '/', label: 'Console' },
  { page: 's2', href: '/s2', label: 'S2, delegated administration' },
  { page: 's5', href: '/s5', label: 'S5, integration' },
  { page: 's8', href: '/s8', label: 'S8, migration' },
] as const;
export type ConsolePageKey = (typeof CONSOLE_PAGES)[number]['page'];

/** What one console page brings to the shell. Every value is trusted HTML, CSS or script from this service's own code. */
export interface ConsolePageSpec {
  /** The header link that is this page. */
  page: ConsolePageKey;
  /** The page's own name in the tab title, before the brand; the main console has none. */
  title?: string;
  /** The line under the wordmark: what this page is for. */
  lead: string;
  /** The page's sections, inside <main>. */
  main: string;
  /** CSS for the page's own sections, after the shared stylesheet. */
  style?: string;
  /** The page's inline script, if it has one. */
  script?: string;
}

/** The console's stylesheet, shared by every console page. */
const STYLE = `
  /* Design tokens: night by default, the header switch turns on the light set. No purple, green or red. */
  :root {
    color-scheme: dark;
    --ground: #121619;
    --surface: #1a2025;
    --ink: #e9edef;
    --ink-muted: #a7b2b8;
    --rule: #59656d;
    --control-edge: #7c8890;
    --plate: #2b343b;
    --plate-edge: #6c7880;
    --on-plate: #ffffff;
    --muted: #232b31;
    --ring: #e9edef;
    --ghost-hover: color-mix(in oklab, var(--muted) 50%, transparent);
    --switch-off: color-mix(in oklab, var(--control-edge) 80%, transparent);
    --field-fill: color-mix(in oklab, var(--control-edge) 30%, transparent);
    --field-hover: color-mix(in oklab, var(--control-edge) 50%, transparent);
    --font-sign: "Overpass", "Helvetica Neue", Arial, sans-serif;
    --font-code: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
    --radius: 0.375rem;
  }
  :root:has(#theme-light:checked) {
    color-scheme: light;
    --ground: #eef1f3;
    --surface: #ffffff;
    --ink: #11171b;
    --ink-muted: #46525a;
    --rule: #8a959c;
    --control-edge: #6f7b83;
    --plate: #1d2327;
    --plate-edge: #1d2327;
    --muted: #e2e7ea;
    --ring: #1d2327;
    --ghost-hover: var(--muted);
    --switch-off: var(--control-edge);
    --field-fill: transparent;
    --field-hover: transparent;
  }
  * { box-sizing: border-box; }
  html { background: var(--ground); font-size: 100%; }
  @media (min-width: 64rem) { html { font-size: 106.25%; } }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font: 400 1rem/1.5 var(--font-sign);
    font-variant-numeric: tabular-nums;
    caret-color: var(--ring);
    scrollbar-color: var(--rule) transparent;
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: color-mix(in oklab, var(--plate) 22%, transparent); color: var(--ink); }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  h1, h2 { text-wrap: balance; }
  svg {
    flex: none;
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Header: a graphite tile, the wordmark over its line, the theme switch. */
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 2rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--rule);
    background: var(--surface);
  }
  .brand { display: flex; flex: 1 1 0%; align-items: center; gap: 0.75rem; min-width: 0; }
  .tile {
    display: grid;
    flex: none;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 1px solid var(--plate-edge);
    border-radius: calc(var(--radius) * 0.6);
    background: var(--plate);
    color: var(--on-plate);
  }
  .tile svg { width: 1.25rem; height: 1.25rem; }
  .titles { display: flex; flex-direction: column; min-width: 0; }
  h1 { margin: 0; font-size: 1.5rem; font-weight: 900; line-height: 1.25; letter-spacing: -0.025em; }
  h1 span { color: var(--ink-muted); font-size: 1rem; font-weight: 400; letter-spacing: 0; }
  .titles p { margin: 0; color: var(--ink-muted); font-size: 0.875rem; line-height: 1.4286; }
  .theme {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius);
    cursor: pointer;
  }
  .theme:hover { background: var(--ghost-hover); }
  .theme input {
    appearance: none;
    -webkit-appearance: none;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    cursor: pointer;
  }
  .theme .moon, :root:has(#theme-light:checked) .theme .sun { display: none; }
  :root:has(#theme-light:checked) .theme .moon { display: block; }

  /* Sections: a rule, a title, one line on what it does, then a framed table. Twelve columns from 80rem. */
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2rem 2.5rem;
    width: 100%;
    max-width: 96rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 2.5rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--rule);
  }
  .head { display: flex; flex-direction: column; gap: 0.25rem; }
  h2 { margin: 0; font-size: 1.25rem; font-weight: 800; line-height: 1.4; }
  .summary { margin: 0; max-width: 75ch; color: var(--ink-muted); font-size: 0.875rem; line-height: 1.4286; }
  @media (min-width: 40rem) { .bar, main { padding-inline: 1.5rem; } }
  #banner {
    display: none;
    grid-column: 1 / -1;
    padding: 0.75rem 1rem;
    border: 1px solid var(--ink);
    border-radius: calc(var(--radius) * 0.8);
    background: var(--surface);
    font-weight: 600;
  }

  .frame {
    overflow-x: auto;
    border: 1px solid var(--rule);
    border-radius: calc(var(--radius) * 0.8);
    background: var(--surface);
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.75rem 0.5rem; text-align: left; vertical-align: middle; }
  th:first-child, td:first-child { padding-left: 1rem; }
  th:last-child, td:last-child { padding-right: 1rem; }
  thead th {
    border-bottom: 1px solid var(--rule);
    font-size: 0.875rem;
    font-weight: 700;
    line-height: 1.4286;
    vertical-align: top;
    white-space: nowrap;
  }
  th.fact { font-family: var(--font-code); font-weight: 600; }
  tbody tr + tr td { border-top: 1px solid var(--rule); }
  .controls th + th, .controls td + td { width: 1%; white-space: nowrap; }
  .plain td:first-child { width: 6.5rem; font-weight: 700; }
  .plain td + td { font: 400 0.875rem/1.4286 var(--font-code); }

  /* A row's name, its key and, under them, the line that says what the portal answered. */
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who .name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 0.5rem; font-weight: 700; }
  .who small { color: var(--ink-muted); font: 400 0.875rem/1.4286 var(--font-code); }
  .who .status { min-height: 1.25rem; }
  .status {
    display: block;
    margin: 0;
    color: var(--ink-muted);
    font-size: 0.875rem;
    line-height: 1.4286;
    overflow-wrap: anywhere;
  }
  .status.ok { color: var(--ink); font-weight: 600; }
  .status.ok::before {
    content: "";
    display: inline-block;
    width: 0.3em;
    height: 0.6em;
    margin: 0 0.6em 0 0.2em;
    border: solid currentColor;
    border-width: 0 0.14em 0.14em 0;
    vertical-align: middle;
    transform: rotate(45deg);
  }
  .status.bad {
    width: fit-content;
    max-width: 100%;
    padding: 0.125rem 0.5rem;
    border: 1px solid var(--ink);
    border-radius: calc(var(--radius) * 0.6);
    color: var(--ink);
    font-weight: 600;
  }

  /* The facts' controls: a switch with its stored value, a select, a segmented choice. A set value is filled in Graphite Ink. */
  .switch { display: flex; align-items: center; gap: 0.5rem; width: fit-content; }
  .switch input {
    appearance: none;
    -webkit-appearance: none;
    position: relative;
    flex: none;
    width: 32px;
    height: 18.4px;
    margin: 0;
    border: 1px solid transparent;
    border-radius: 9999px;
    background: var(--switch-off);
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
  }
  .switch input::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 0;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    background: var(--ground);
    transform: translateY(-50%);
    transition: transform 0.15s;
  }
  .switch input::after { content: ""; position: absolute; inset: -8px -12px; }
  .switch input:checked { border-color: var(--ink); background: var(--ink); }
  .switch input:checked::before { transform: translate(14px, -50%); }
  .bool { width: 3rem; font: 400 0.875rem/1.4286 var(--font-code); }
  .bool::after { content: "false"; }
  .switch input:checked ~ .bool::after { content: "true"; }
  .select { position: relative; display: block; width: 9rem; }
  .select::after {
    content: "";
    position: absolute;
    top: calc(50% - 2px);
    right: 13px;
    width: 6px;
    height: 6px;
    border: solid var(--ink-muted);
    border-width: 0 1.5px 1.5px 0;
    transform: translateY(-50%) rotate(45deg);
    pointer-events: none;
  }
  .select select {
    appearance: none;
    -webkit-appearance: none;
    display: block;
    width: 100%;
    height: 2.25rem;
    margin: 0;
    padding: 0 2rem 0 0.625rem;
    border: 1px solid var(--control-edge);
    border-radius: var(--radius);
    background: var(--field-fill);
    color: var(--ink);
    font: 400 0.875rem/1.4286 var(--font-code);
    cursor: pointer;
    transition: background-color 0.15s;
  }
  .select select:hover { background: var(--field-hover); }
  .select option { background: var(--surface); color: var(--ink); }
  .segmented { display: flex; width: fit-content; }
  .segmented label { position: relative; display: block; cursor: pointer; }
  .segmented input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .segmented span {
    display: grid;
    place-items: center;
    min-width: 2.25rem;
    height: 2.25rem;
    padding: 0 0.5rem;
    border: 1px solid var(--control-edge);
    font: 500 0.875rem/1 var(--font-code);
    white-space: nowrap;
    transition: background-color 0.15s;
  }
  .segmented label + label span { border-left-width: 0; }
  .segmented label:first-child span { border-radius: var(--radius) 0 0 var(--radius); }
  .segmented label:last-child span { border-radius: 0 var(--radius) var(--radius) 0; }
  .segmented label:hover input:not(:checked) + span { background: var(--muted); }
  .segmented input:checked + span { border-color: var(--ink); background: var(--ink); color: var(--ground); }
  .segmented input:focus-visible + span { position: relative; z-index: 1; outline: 2px solid var(--ring); outline-offset: 2px; }

  /* The primary button is a graphite plate; disabled, it keeps a legible label on the muted fill. */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    height: 2.25rem;
    padding: 0 0.625rem 0 0.5rem;
    border: 1px solid var(--plate-edge);
    border-radius: var(--radius);
    background: var(--plate);
    color: var(--on-plate);
    font: 500 0.875rem/1 var(--font-sign);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    transition: background-color 0.15s;
  }
  .btn:hover { background: color-mix(in oklab, var(--plate) 80%, transparent); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { border-color: var(--rule); background: var(--muted); color: var(--ink-muted); cursor: default; pointer-events: none; }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(11rem, 100%), 1fr));
    gap: 0.75rem 1.5rem;
    margin: 0;
  }
  .facts div { display: flex; flex-direction: column; min-width: 0; }
  .facts dt { color: var(--ink-muted); font-size: 0.875rem; line-height: 1.4286; }
  .facts dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }

  /* The header's page links, on a row of their own under the wordmark: the current page underlined in ink. */
  .pages { display: flex; flex-basis: 100%; flex-wrap: wrap; align-items: center; gap: 0.25rem 1.25rem; }
  .pages a {
    padding: 0.25rem 0;
    border-bottom: 2px solid transparent;
    color: var(--ink-muted);
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.4286;
    text-decoration: none;
  }
  .pages a:hover { color: var(--ink); }
  .pages a[aria-current="page"] { border-bottom-color: var(--ink); color: var(--ink); }
`;

/** One console page: the shared head and header (with the link to every page), then the page's own sections and script. */
export function consolePage(p: ConsolePageSpec): string {
  const links = CONSOLE_PAGES.map(({ page, href, label }) => `<a href="${href}"${page === p.page ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${p.title === undefined ? BRAND : `${p.title} – ${BRAND}`}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Overpass:wght@400..900&display=swap">
<style>${STYLE}${p.style ?? ''}</style>
</head>
<body>
<header class="bar">
  <div class="brand">
    <span class="tile"><svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg></span>
    <div class="titles">
      <h1>Great Eagle systems <span>(simulated)</span></h1>
      <p>${p.lead}</p>
    </div>
  </div>
  <label class="theme" title="Light theme">
    <input type="checkbox" id="theme-light" role="switch" aria-label="Light theme">
    <svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
    <svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>
  </label>
  <nav class="pages" aria-label="Console pages">${links}</nav>
</header>
<main>
${p.main}
</main>
${p.script === undefined ? '' : `<script>${p.script}</script>\n`}</body>
</html>
`;
}

/** The main console's grid: the trust service beside organizations and the account master, the cleanup job across. */
const MAIN_STYLE = `
  @media (min-width: 48rem) {
    main { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .trust, .cleanup { grid-column: 1 / -1; }
  }
  @media (min-width: 80rem) {
    main { grid-template-columns: repeat(12, minmax(0, 1fr)); }
    .trust { grid-column: span 7; grid-row: span 2; }
    .orgs, .eans { grid-column: span 5; }
  }
`;

const MAIN_SECTIONS = `  <div id="banner" role="alert"></div>
  <section class="trust" aria-labelledby="trust-title">
    <div class="head">
      <h2 id="trust-title">Trust service</h2>
      <p class="summary">Great Eagle's trust facts for each user.</p>
    </div>
    <div class="frame">
      <table class="controls" aria-labelledby="trust-title">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col" class="fact">identity_verified</th>
            <th scope="col" class="fact">duplicate_check</th>
            <th scope="col" class="fact">risk_state</th>
          </tr>
        </thead>
        <tbody id="users"></tbody>
      </table>
    </div>
  </section>
  <section class="orgs" aria-labelledby="orgs-title">
    <div class="head">
      <h2 id="orgs-title">Organizations</h2>
      <p class="summary">Great Eagle's ownership check for each organization.</p>
    </div>
    <div class="frame">
      <table class="controls" aria-labelledby="orgs-title">
        <thead><tr><th scope="col">Organization</th><th scope="col" class="fact">ownership_verified</th></tr></thead>
        <tbody id="orgs"></tbody>
      </table>
    </div>
  </section>
  <section class="eans" aria-labelledby="eans-title">
    <div class="head">
      <h2 id="eans-title">Account master</h2>
      <p class="summary">EANs and their owners (read-only).</p>
    </div>
    <div class="frame">
      <table class="plain" aria-labelledby="eans-title">
        <thead><tr><th scope="col">EAN</th><th scope="col">Owner</th></tr></thead>
        <tbody id="eans"></tbody>
      </table>
    </div>
  </section>
  <section class="cleanup" aria-labelledby="cleanup-title">
    <div class="head">
      <h2 id="cleanup-title">Cleanup job</h2>
      <p class="summary">Housekeeping that removes expired grant entries. It is not the security control: a grant stops working at its expiry whether or not this job has run.</p>
    </div>
    <dl class="facts">
      <div><dt>Interval</dt><dd id="interval">–</dd></div>
      <div><dt>Last run</dt><dd id="last-run">–</dd></div>
      <div><dt>Next run</dt><dd id="next-run">–</dd></div>
      <div><dt>Last removed</dt><dd id="last-removed">–</dd></div>
      <div><dt>Last error</dt><dd id="last-error">–</dd></div>
    </dl>
    <div class="actions">
      <button id="run-cleanup" class="btn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>Run cleanup now</button>
      <span id="run-status" class="status" aria-live="polite"></span>
    </div>
  </section>`;

const MAIN_SCRIPT = `
'use strict';
const byId = (id) => document.getElementById(id);
// Rows with a change in flight: polling leaves their controls alone until the portal has answered.
const pending = new Set();
const userRows = new Map();
const orgRows = new Map();
let cleanupStatus = null;

async function api(method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status);
  return data;
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

function cell(row, content) {
  const td = document.createElement('td');
  td.append(content);
  row.append(td);
  return td;
}

function statusSpan() {
  const span = document.createElement('span');
  span.className = 'status';
  span.setAttribute('aria-live', 'polite');
  return span;
}

function checkbox(label, onChange) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  input.addEventListener('change', onChange);
  return input;
}

function select(label, options, onChange) {
  const el = document.createElement('select');
  el.setAttribute('aria-label', label);
  for (const option of options) el.append(new Option(option, option));
  el.addEventListener('change', onChange);
  return el;
}

// A span the stylesheet can decorate: the select's chevron, the switch's stored value.
function wrapped(className, ...children) {
  const span = document.createElement('span');
  span.className = className;
  span.append(...children);
  return span;
}

// A switch: the checkbox with its stored value beside it ("true" or "false", which the stylesheet draws from the checkbox's state).
function switchOf(input) {
  const value = document.createElement('span');
  value.className = 'bool';
  value.setAttribute('aria-hidden', 'true');
  return wrapped('switch', input, value);
}

// A segmented choice: radios that read and write "value" as a select does, so a row treats both alike.
function segmented(label, name, options, onChange) {
  const group = document.createElement('span');
  group.className = 'segmented';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  const radios = options.map((option) => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = option;
    const text = document.createElement('span');
    text.textContent = option;
    const item = document.createElement('label');
    item.append(radio, text);
    group.append(item);
    return radio;
  });
  Object.defineProperty(group, 'value', {
    get: () => radios.find((radio) => radio.checked)?.value ?? '',
    set: (value) => {
      for (const radio of radios) radio.checked = radio.value === value;
    },
  });
  group.addEventListener('change', onChange);
  return group;
}

function setIfChanged(el, prop, value) {
  if (el[prop] === value) return false;
  el[prop] = value;
  return true;
}

// A value that changed elsewhere (a reset, another tab) makes the row's last message stale.
function syncRow(row, updates) {
  if (pending.has(row.rowKey)) return;
  const changed = updates.map(([el, prop, value]) => setIfChanged(el, prop, value));
  if (changed.includes(true)) setStatus(row.status, '');
}

// One change: the row shows "sent to portal" once the portal has confirmed it, or the error.
async function send(rowKey, path, body, statusEl) {
  pending.add(rowKey);
  setStatus(statusEl, 'sending…');
  try {
    await api('PUT', path, body);
    setStatus(statusEl, 'sent to portal', 'ok');
  } catch (error) {
    setStatus(statusEl, error.message, 'bad');
  } finally {
    pending.delete(rowKey);
    refresh();
  }
}

// The row's name and key, with its status line beneath them.
function who(name, key, status) {
  const line = document.createElement('div');
  line.className = 'name';
  line.textContent = name;
  const small = document.createElement('small');
  small.textContent = key;
  line.append(small);
  const div = document.createElement('div');
  div.className = 'who';
  div.append(line, status);
  return div;
}

function renderUsers(users) {
  for (const user of users) {
    let row = userRows.get(user.key);
    if (!row) {
      const rowKey = 'user:' + user.key;
      const path = '/api/trust/users/' + encodeURIComponent(user.key);
      const tr = document.createElement('tr');
      const status = statusSpan();
      const identity = checkbox(user.name + ' identity_verified', () => send(rowKey, path, { identity_verified: identity.checked }, status));
      const duplicate = select(user.name + ' duplicate_check', ['clear', 'suspected', 'confirmed'], () => send(rowKey, path, { duplicate_check: duplicate.value }, status));
      const risk = segmented(user.name + ' risk_state', rowKey, ['ok', 'suspended'], () => send(rowKey, path, { risk_state: risk.value }, status));
      cell(tr, who(user.name, user.key, status));
      cell(tr, switchOf(identity));
      cell(tr, wrapped('select', duplicate));
      cell(tr, risk);
      byId('users').append(tr);
      row = { rowKey, status, identity, duplicate, risk };
      userRows.set(user.key, row);
    }
    syncRow(row, [
      [row.identity, 'checked', user.facts.identity_verified],
      [row.duplicate, 'value', user.facts.duplicate_check],
      [row.risk, 'value', user.facts.risk_state],
    ]);
  }
}

function renderOrgs(orgs) {
  for (const org of orgs) {
    let row = orgRows.get(org.key);
    if (!row) {
      const rowKey = 'org:' + org.key;
      const path = '/api/trust/orgs/' + encodeURIComponent(org.key);
      const tr = document.createElement('tr');
      const status = statusSpan();
      const verified = checkbox(org.name + ' ownership_verified', () => send(rowKey, path, { ownership_verified: verified.checked }, status));
      cell(tr, who(org.name, org.key, status));
      cell(tr, switchOf(verified));
      byId('orgs').append(tr);
      row = { rowKey, status, verified };
      orgRows.set(org.key, row);
    }
    syncRow(row, [[row.verified, 'checked', org.ownership_verified]]);
  }
}

function renderEans(eans) {
  byId('eans').replaceChildren(...eans.map((ean) => {
    const tr = document.createElement('tr');
    cell(tr, ean.key);
    cell(tr, ean.org);
    return tr;
  }));
}

function duration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return seconds + ' s';
  return seconds === 0 ? minutes + ' min' : minutes + ' min ' + seconds + ' s';
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

function renderCleanup() {
  const s = cleanupStatus;
  if (!s) return;
  byId('interval').textContent = duration(s.intervalMs);
  byId('last-run').textContent = s.lastRunAt === null ? 'not run yet' : clockTime(s.lastRunAt);
  byId('next-run').textContent = s.nextRunAt === null ? 'not scheduled' : clockTime(s.nextRunAt) + ' (in ' + duration(s.nextRunAt - Date.now()) + ')';
  byId('last-removed').textContent = s.lastRemoved === null ? '–' : String(s.lastRemoved);
  byId('last-error').textContent = s.lastError === null ? 'none' : s.lastError;
}

async function refresh() {
  try {
    const [users, orgs, eans, cleanup] = await Promise.all([
      api('GET', '/api/trust/users'),
      api('GET', '/api/trust/orgs'),
      api('GET', '/api/accounts/eans'),
      api('GET', '/api/cleanup/status'),
    ]);
    renderUsers(users);
    renderOrgs(orgs);
    renderEans(eans);
    cleanupStatus = cleanup;
    renderCleanup();
    // After a reset the job has no last run, so the last "removed" message no longer applies.
    if (cleanup.lastRunAt === null && !byId('run-cleanup').disabled) setStatus(byId('run-status'), '');
    banner('');
  } catch (error) {
    banner('Cannot reach the Great Eagle systems mock: ' + error.message);
  }
}

byId('run-cleanup').addEventListener('click', async () => {
  const button = byId('run-cleanup');
  const status = byId('run-status');
  button.disabled = true;
  setStatus(status, 'running…');
  try {
    const result = await api('POST', '/api/cleanup/run');
    setStatus(status, 'removed ' + result.removed + (result.removed === 1 ? ' expired grant entry' : ' expired grant entries'), 'ok');
  } catch (error) {
    setStatus(status, error.message, 'bad');
  } finally {
    button.disabled = false;
    refresh();
  }
});

refresh();
setInterval(refresh, 2000);
setInterval(renderCleanup, 250);
`;

/** The main console, at GET /: the trust service, organizations, the account master and the cleanup job. */
export const CONSOLE_HTML = consolePage({
  page: 'console',
  lead: 'Presenter console. A change here is sent to the portal, which writes it to Permit.',
  main: MAIN_SECTIONS,
  style: MAIN_STYLE,
  script: MAIN_SCRIPT,
});
