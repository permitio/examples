import type { ItemDecision } from '#src/authorize';
import type { Classification, ClassifierName } from '#src/classifier';
import { PERSONAS } from '#src/personas';
import { ACTIONS, userSetFor } from '#src/policy';

const CLASSIFIER_INTROS: Record<ClassifierName, string> = {
  arcjet: 'Arcjet classifies each request.',
  'user-agent': 'A User-Agent check classifies each request (set ARCJET_KEY to have Arcjet do it).',
};

/** Everything the demo page shows for one request. */
export interface PageView {
  /** The classifier the app runs. */
  classifier: ClassifierName;
  /** The persona the request was sent as, or undefined for the browser's own request. */
  personaKey: string | undefined;
  userAgent: string | undefined;
  classification: Classification;
  /** Permit's answers, or undefined when the request was blocked or the PDP failed. */
  decisions: ItemDecision[] | undefined;
  error: string | undefined;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1b22; --muted: #5d5868; --bg: #fbfaf7; --card: #fff;
  --line: #e4e0ea; --accent: #6a32d1; --allow: #146c2e; --allow-bg: #e3f4e7; --deny: #a3261c;
  --deny-bg: #fbe6e3; }
@media (prefers-color-scheme: dark) { :root { --fg: #ece9f1; --muted: #a9a3b4; --bg: #16141a;
  --card: #1f1c24; --line: #34303c; --accent: #b598ff; --allow: #8be0a1; --allow-bg: #173322;
  --deny: #ffaaa1; --deny-bg: #3a1c19; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
p { margin: 0 0 16px; color: var(--muted); }
code { font: 0.85em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
a { color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; }
nav a { display: block; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--card); color: var(--fg); text-decoration: none; }
nav a small { display: block; color: var(--muted); font-size: 0.8rem; }
nav a[aria-current="page"] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 16px; margin: 0 0 16px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
td.allow, td.deny { font-weight: 600; text-align: center; }
td.allow { color: var(--allow); background: var(--allow-bg); }
td.deny { color: var(--deny); background: var(--deny-bg); }
.error { color: var(--deny); }
`;

function personaLinks(current: string | undefined): string {
  const link = (href: string, label: string, summary: string, active: boolean) =>
    `<a href="${href}"${active ? ' aria-current="page"' : ''}>${escapeHtml(label)}` +
    `<small>${escapeHtml(summary)}</small></a>`;
  return [
    link('/', 'Your browser', 'Its own User-Agent', current === undefined),
    ...PERSONAS.map((p) => link(`/?as=${p.key}`, p.label, p.summary, current === p.key)),
  ].join('');
}

function section(heading: string, body: string): string {
  return `<section><h2>${heading}</h2>${body}</section>`;
}

function callerSection(view: PageView): string {
  const { classification } = view;
  const userAgent =
    view.userAgent === undefined ? '<em>none</em>' : `<code>${escapeHtml(view.userAgent)}</code>`;
  const rows = [`<dt>User-Agent</dt><dd>${userAgent}</dd>`];
  if (classification.kind === 'caller') {
    rows.push(
      `<dt>Bot type</dt><dd><code>${classification.botType}</code></dd>`,
      `<dt>User set</dt><dd><code>${userSetFor(classification.botType)}</code></dd>`,
    );
  }
  const by = classification.by === 'arcjet' ? 'Arcjet' : 'User-Agent check';
  rows.push(
    `<dt>Classified by</dt><dd>${by}</dd>`,
    `<dt>Why</dt><dd>${escapeHtml(classification.reason)}</dd>`,
  );
  return section('The caller', `<dl>${rows.join('')}</dl>`);
}

function decisionsSection(view: PageView): string {
  const heading = "Permit's decisions";
  if (view.classification.kind === 'blocked') {
    const reason = escapeHtml(view.classification.reason);
    return section(heading, `<p class="error">Blocked before Permit was asked: ${reason}</p>`);
  }
  if (view.decisions === undefined)
    return section(heading, `<p class="error">${escapeHtml(view.error ?? 'No decisions.')}</p>`);
  const head = ['Item', 'Resource set', ...ACTIONS].map((h) => `<th scope="col">${h}</th>`);
  const rows = view.decisions.map(({ item, resourceSet, allowed }) => {
    const cells = ACTIONS.map((a) =>
      allowed[a] ? '<td class="allow">Allow</td>' : '<td class="deny">Deny</td>',
    );
    const name = `<th scope="row">${escapeHtml(item.name)}</th>`;
    return `<tr>${name}<td><code>${resourceSet}</code></td>${cells.join('')}</tr>`;
  });
  const table =
    `<table><thead><tr>${head.join('')}</tr></thead>` + `<tbody>${rows.join('')}</tbody></table>`;
  return section(heading, `<div class="scroll">${table}</div>`);
}

/** The demo page: pick a caller, see how it was classified and what Permit lets it do. */
export function renderPage(view: PageView): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fine-grained bot protection</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Fine-grained bot protection</h1>
<p>${CLASSIFIER_INTROS[view.classifier]} Permit then decides what that kind of caller may do
with each item. Send the request as:</p>
<nav aria-label="Send the request as">${personaLinks(view.personaKey)}</nav>
${callerSection(view)}
${decisionsSection(view)}
<p>The API behind this page, <a href="/api/items"><code>/api/items</code></a>, lists the items
the caller may read.</p>
</main>
</body>
</html>
`;
}
