// Fleet Ops front end. Every allow/deny comes from the local PDP, through the Permit Go SDK on the
// server, and every check the server made for a page or an action is added to the PDP log on the right.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? data.detail ?? `Request failed with status ${res.status}`);
  return data;
}

// Remembers who is signed in across reloads; the app works without it.
const saved = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = { meta: null, user: null, org: null, orgs: [], log: [], flash: null, busy: false };

const ALL = '*'; // "All my organizations": the fleet list, each truck checked acting for its own organization
const orgName = (key) => (key === ALL ? 'all your organizations' : state.orgs.find((o) => o.key === key)?.name ?? key);
const query = () => `user=${encodeURIComponent(state.user)}&org=${encodeURIComponent(state.org)}`;
const route = () => location.hash.match(/^#\/(truck|site|people|access|organizations)(?:\/([a-z0-9-]+))?/);
const VIA = { home: '', platform: ' (platform operator)', granted: ' (granted access)', breakglass: ' (break-glass)' };
const ROLE_NAMES = { site_manager: 'Site manager', operator: 'Operator', technician: 'Technician', viewer: 'Viewer' };
const TIERS = ['tier1', 'tier2', 'tier3'];

// Switchers -------------------------------------------------------------------------------------------

// Signing in lands in the person's home organization unless `keep` is one of theirs. Person and
// organization are set together, so a page rendered meanwhile never pairs one with the other's old value.
async function signIn(user, keep) {
  const { orgs } = await api(`/api/orgs?user=${encodeURIComponent(user)}`);
  const org = orgs.some((o) => o.key === keep) || (keep === ALL && orgs.length > 1)
    ? keep
    : (orgs.find((o) => o.via === 'home') ?? orgs[0])?.key;
  Object.assign(state, { user, orgs, org });
  saved.set('user', user);
  saved.set('org', org ?? '');
}

function renderSwitchers() {
  const groups = new Map();
  for (const u of state.meta.users) groups.set(u.org, [...(groups.get(u.org) ?? []), u]);
  $('#user').innerHTML = [...groups]
    .map(([org, users]) => `<optgroup label="${esc(org)}">${users
      .map((u) => `<option value="${u.key}" ${u.key === state.user ? 'selected' : ''}>${esc(u.name)}, ${esc(u.title)}</option>`)
      .join('')}</optgroup>`)
    .join('');
  $('#org').innerHTML = state.orgs
    .map((o) => `<option value="${o.key}" ${o.key === state.org ? 'selected' : ''}>${esc(o.name)}${VIA[o.via] ?? ''}</option>`)
    .join('') + (state.orgs.length > 1 ? `<option value="${ALL}" ${state.org === ALL ? 'selected' : ''}>All my organizations (fleet list)</option>` : '');
}

function renderNav() {
  const current = route()?.[1] ?? 'fleet';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === current || (a.dataset.nav === 'fleet' && ['truck', 'site'].includes(current));
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

// Pages -------------------------------------------------------------------------------------------------

let pageSeq = 0;

// Fetches a page's data and logs the checks behind it. Returns null when a newer page load started
// meanwhile, so a slower, older answer never replaces the page the person is on now.
async function pageData(path) {
  const seq = ++pageSeq;
  const data = await api(`${path}${path.includes('?') ? '&' : '?'}${query()}`);
  addLog(data.log);
  return seq === pageSeq ? data : null;
}

async function render() {
  renderNav();
  try {
    const r = route();
    const page = r?.[1];
    if (!state.org && page !== 'organizations') {
      $('#page').innerHTML = `<h1>No organization</h1><p class="sub">${esc(state.meta.users.find((u) => u.key === state.user)?.name)} can't act for any organization right now.</p>`;
      return;
    }
    if (state.org === ALL && page && page !== 'organizations') {
      $('#page').innerHTML = '<h1>Pick an organization</h1><p class="sub">This page acts for one organization at a time. Pick one in the Organization menu.</p>';
      return;
    }
    if (page === 'truck') await truckPage(r[2]);
    else if (page === 'site') await sitePage(r[2]);
    else if (page === 'people') await peoplePage();
    else if (page === 'access') await accessPage();
    else if (page === 'organizations') await orgsPage();
    else await fleetPage();
  } catch (err) {
    $('#page').innerHTML = `<div class="denied"><h1>Something went wrong</h1><p>${esc(err.message)}</p><p>Check that the PDP container and the app server are running.</p></div>`;
  }
}

function statusBadge(t) {
  if (t.lifecycle === 'decommissioned') return '<span class="badge decommissioned">Decommissioned</span>';
  if (t.lifecycle === 'unassigned') return '<span class="badge decommissioned">Unassigned</span>';
  if (t.lifecycle === 'transferring') return '<span class="badge road">Transferring</span>';
  return '<span class="badge active">Active</span>';
}

function operatorBadge(t) {
  return t.operator ? ` <span class="badge road">Operated by ${esc(t.operator)}</span>` : '';
}

function takeFlash() {
  const f = state.flash;
  state.flash = null;
  return f ? `<p class="flash ${f.kind === 'error' ? 'error' : ''}">${esc(f.text)}</p>` : '';
}

function deniedHtml(crumbs, name, reason, action = 'view') {
  state.flash = null;
  return `${crumbs}<div class="denied">
    <h1>You don't have access to ${esc(name)}</h1>
    <p>Acting for ${esc(orgName(state.org))}, the PDP denied <code>${esc(action)}</code>.</p>
    <p>${esc(reason)}</p></div>`;
}

const options = (list, selected) => list.map((o) => `<option value="${esc(o.key)}" ${o.key === selected ? 'selected' : ''}>${esc(o.name)}</option>`).join('');

function truckRows(trucks, { site = true, org = false } = {}) {
  return trucks
    .map((t) => `<tr><td><a href="#/truck/${t.key}" ${org ? `data-org="${t.org}"` : ''}>${esc(t.name)}</a>${operatorBadge(t)}</td>${
      org ? `<td>${esc(orgName(t.org))}</td>` : ''
    }${
      site ? `<td>${org ? esc(t.site) : `<a href="#/site/${t.siteKey}">${esc(t.site)}</a>`}</td><td>${esc(t.region)}</td>` : ''
    }<td>${statusBadge(t)}</td></tr>`)
    .join('');
}

async function fleetPage() {
  const data = await pageData('/api/fleet');
  if (!data) return;
  const n = data.trucks.length;
  const all = state.org === ALL;
  $('#page').innerHTML = `
    <h1>Fleet</h1>
    <p class="sub">${n} ${n === 1 ? 'truck' : 'trucks'} in ${esc(orgName(state.org))}${all ? '. Each one was checked acting for its own organization.' : ''}</p>
    ${takeFlash()}
    ${n
      ? `<table class="fleet"><thead><tr><th>Truck</th>${all ? '<th>Organization</th>' : ''}<th>Site</th><th>Region</th><th>Status</th></tr></thead><tbody>${truckRows(data.trucks, { org: all })}</tbody></table>`
      : `<p class="none" style="margin-top:18px">${data.total === 0
          ? `${esc(orgName(state.org))} has no trucks.`
          : `You don't have access to any trucks in ${esc(orgName(state.org))}.`}</p>`}`;
}

async function truckPage(key) {
  const data = await pageData(`/api/trucks/${key}`);
  if (!data) return;
  if (data.notFound) {
    $('#page').innerHTML = `<p class="crumbs"><a href="#/">Fleet</a></p><h1>There is no truck called ${esc(key)}</h1>`;
    return;
  }
  if (data.denied) {
    $('#page').innerHTML = deniedHtml(`<p class="crumbs"><a href="#/">Fleet</a> / ${esc(data.truck.name)}</p>`, data.truck.name, data.reason);
    return;
  }

  const t = data.truck;
  const can = (a) => data.actions.includes(a);
  const active = t.lifecycle === 'active';
  const buttons = [
    can('operate')
      ? `<select id="lane" aria-label="Lane">${t.lanes.map((l) => `<option>${esc(l)}</option>`).join('')}</select><button type="button" class="btn" data-act="dispatch">Dispatch</button>`
      : '',
    can('service_basic') ? '<button type="button" class="btn secondary" data-act="service_basic">Log basic service</button>' : '',
    can('service_advanced') ? '<button type="button" class="btn secondary" data-act="service_advanced">Run advanced service</button>' : '',
    can('decommission') && active ? '<button type="button" class="btn danger" data-act="decommission">Decommission</button>' : '',
    can('decommission') && !active ? '<button type="button" class="btn secondary" data-act="reactivate">Reactivate</button>' : '',
  ].join('');

  const history = data.history.length
    ? `<ul class="rows">${data.history.map((h) => `<li><span>${esc(h.kind)}</span><span class="meta">${esc(h.by)}, ${esc(h.time)}</span></li>`).join('')}</ul>`
    : '<p class="none">Nothing logged yet.</p>';

  const details = data.details
    ? `<h2 class="section">Details</h2>
       <p class="sub">The attribute-based sets read these values: assets where region = South, assets where served_account = Acct1.</p>
       <div class="grant">
         <label class="field">Region <select id="detail-region">${data.details.regions.map((r) => `<option ${r === data.details.region ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
         <label class="field">Served account <select id="detail-account">${data.details.accounts.map((r) => `<option ${r === data.details.account ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
         <button type="button" class="btn secondary" data-act="edit_details">Save details</button>
       </div>`
    : '';

  const move = data.moveTargets.length
    ? `<div class="grant"><select id="move-site" aria-label="Move to site">${options(data.moveTargets)}</select><button type="button" class="btn secondary" data-act="move">Move to this site</button></div>`
    : '';
  const transfer = data.transferTargets.length
    ? `<div class="grant"><select id="transfer-site" aria-label="Transfer to">${options(data.transferTargets)}</select><button type="button" class="btn danger" data-act="transfer">Transfer to this organization</button></div>`
    : '';
  const fleetAdmin = move || transfer
    ? `<h2 class="section">Fleet management</h2>
       <p class="sub">${move ? 'A move replaces one parent link; no role assignment changes.' : ''}${move && transfer ? ' ' : ''}${transfer ? 'A transfer to another organization is for platform staff.' : ''}</p>
       ${move}${transfer}`
    : '';

  const partners = data.partners === null ? '' : `
    <h2 class="section">Partner access</h2>
    <p class="sub">Technicians from partner companies get this truck only, and nothing else in ${esc(t.owner)}.</p>
    ${data.partners.length
      ? `<ul class="rows">${data.partners.map((p) => `<li><span>${esc(p.name)}</span><button type="button" class="btn danger" data-act="revoke" data-partner="${p.key}">Revoke</button></li>`).join('')}</ul>`
      : '<p class="none">No partner has access to this truck.</p>'}
    ${data.eligiblePartners.length
      ? `<div class="grant"><select id="partner" aria-label="Partner technician">${options(data.eligiblePartners)}</select><button type="button" class="btn secondary" data-act="grant">Grant access</button></div>`
      : ''}`;

  $('#page').innerHTML = `
    <p class="crumbs"><a href="#/">Fleet</a> / <a href="#/site/${t.siteKey}">${esc(t.site)}</a> / ${esc(t.name)}</p>
    <div class="title-row"><h1>${esc(t.name)}</h1>${statusBadge(t)}${operatorBadge(t)}</div>
    <dl class="facts">
      <div><dt>Owner</dt><dd>${esc(t.owner)}</dd></div>
      ${t.operator ? `<div><dt>Operated by</dt><dd>${esc(t.operator)}</dd></div>` : ''}
      <div><dt>Site</dt><dd>${esc(t.site)}</dd></div>
      <div><dt>Region</dt><dd>${esc(t.region)}</dd></div>
      <div><dt>Served account</dt><dd>${esc(t.servedAccount)}</dd></div>
      <div><dt>Lifecycle state</dt><dd>${esc(t.lifecycle)}</dd></div>
    </dl>
    <div class="actions">${buttons || '<p class="none">You can view this truck. Your roles allow nothing else here.</p>'}</div>
    ${takeFlash()}
    <h2 class="section">History</h2>${history}
    ${details}
    ${fleetAdmin}
    ${partners}`;
}

async function sitePage(key) {
  const data = await pageData(`/api/sites/${key}`);
  if (!data) return;
  if (data.notFound) {
    $('#page').innerHTML = `<p class="crumbs"><a href="#/">Fleet</a></p><h1>There is no site called ${esc(key)}</h1>`;
    return;
  }
  if (data.denied) {
    $('#page').innerHTML = deniedHtml(`<p class="crumbs"><a href="#/">Fleet</a> / ${esc(data.site.name)}</p>`, data.site.name, data.reason);
    return;
  }
  const s = data.site;
  const n = data.trucks.length;
  const teams = data.teams.length
    ? `<h2 class="section">Teams</h2><ul class="rows">${data.teams
        .map((t) => `<li><span>${esc(t.name)}</span><span class="meta">${t.members.length ? esc(t.members.join(', ')) : 'No members'}</span></li>`)
        .join('')}</ul>`
    : '';
  const people = data.people === null ? '' : `
    <h2 class="section">People with roles here</h2>
    <p class="sub">Roles given here reach every truck at ${esc(s.name)}. Give and remove them on the People page.</p>
    ${data.people.length
      ? `<ul class="rows">${data.people.map((p) => `<li><span>${esc(p.name)}</span><span class="meta">${esc(ROLE_NAMES[p.role] ?? p.role)}</span></li>`).join('')}</ul>`
      : '<p class="none">Nobody has a role on this site directly.</p>'}`;

  $('#page').innerHTML = `
    <p class="crumbs"><a href="#/">Fleet</a> / ${esc(s.name)}</p>
    <h1>${esc(s.name)}</h1>
    <dl class="facts">
      <div><dt>Organization</dt><dd>${esc(s.owner)}</dd></div>
      <div><dt>Region</dt><dd>${esc(s.region)}</dd></div>
    </dl>
    ${takeFlash()}
    <h2 class="section">Trucks</h2>
    ${n ? `<table class="fleet"><thead><tr><th>Truck</th><th>Status</th></tr></thead><tbody>${truckRows(data.trucks, { site: false })}</tbody></table>` : '<p class="none">No trucks you can see at this site.</p>'}
    ${teams}
    ${people}`;
}

async function peoplePage() {
  const data = await pageData('/api/people');
  if (!data) return;
  if (data.denied) {
    $('#page').innerHTML = deniedHtml('<h1>People</h1>', `the people of ${orgName(state.org)}`, data.reason, 'manage_users');
    return;
  }
  const giveForm = data.canGiveRoles
    ? `<h2 class="section">Give a role</h2>
       <p class="sub">A role on a site reaches every truck there. The PDP checks <code>assign_roles</code> on the site you pick.</p>
       <div class="grant">
         <select id="give-person" aria-label="Person">${options(data.people.map((p) => ({ key: p.key, name: p.name })))}</select>
         <select id="give-role" aria-label="Role">${options(data.roles, 'operator')}</select>
         <select id="give-site" aria-label="Site">${options(data.sites)}</select>
         <button type="button" class="btn" data-act="assign">Give role</button>
       </div>`
    : '';
  const rows = data.people.map((p) => {
    const roles = p.roles.length
      ? `<ul class="roles">${p.roles.map((r) => `<li>${esc(r.label)}${r.canRemove ? ` <button type="button" class="btn danger small" data-act="unassign" data-key="${p.key}" data-role="${r.role}" data-site="${r.site}">Remove</button>` : ''}</li>`).join('')}</ul>`
      : '<p class="meta">No roles</p>';
    const certs = p.certifications.length ? p.certifications.map((c) => `<span class="badge depot">${esc(c)}</span>`).join(' ') : '<span class="meta">No certifications</span>';
    const editor = p.canCertify
      ? `<div class="grant">${TIERS.map((tier) => `<label class="check"><input type="checkbox" name="cert-${p.key}" value="${tier}" ${p.certifications.includes(tier) ? 'checked' : ''}> ${tier.replace('tier', 'Tier ')}</label>`).join('')}
         <button type="button" class="btn secondary" data-act="certify" data-key="${p.key}">Save certifications</button></div>`
      : '';
    const team = p.team === null
      ? ''
      : `<div class="activity"><p class="meta">${esc(p.team)}: recent activity</p>${p.activity === null
          ? '<p class="none">Only the team\'s supervisor can see this.</p>'
          : p.activity.length
            ? `<ul>${p.activity.map((e) => `<li>${esc(e.text)} <span class="meta">${esc(e.time)}</span></li>`).join('')}</ul>`
            : '<p class="none">No activity yet.</p>'}</div>`;
    const remove = p.canRemove ? `<button type="button" class="btn danger" data-act="remove" data-key="${p.key}">Remove from Permit</button>` : '';
    return `<li class="person"><div class="person-head"><span><strong>${esc(p.name)}</strong> <span class="meta">${esc(p.title)}</span></span>${remove}</div>
      ${roles}<div class="certs">${certs}</div>${editor}${team}</li>`;
  });
  $('#page').innerHTML = `
    <h1>People</h1>
    <p class="sub">${esc(orgName(state.org))}: its people, their roles, and what you may do with each one.</p>
    ${takeFlash()}
    ${giveForm}
    ${rows.length ? `<ul class="people">${rows.join('')}</ul>` : '<p class="none" style="margin-top:18px">Nobody works here.</p>'}`;
}

async function accessPage() {
  const data = await pageData('/api/access');
  if (!data) return;
  if (data.denied) {
    $('#page').innerHTML = deniedHtml('<h1>Access</h1>', `break-glass access in ${orgName(state.org)}`, data.reason, 'assign_roles');
    return;
  }
  const grants = data.grants.length
    ? `<ul class="rows">${data.grants.map((g) => `<li><span>${esc(g.person)} <span class="meta">${esc(g.incident)}, by ${esc(g.by)}</span></span><span class="badge ${g.active ? 'road' : 'decommissioned'}">${g.active ? 'Active until' : 'Expired'} ${esc(g.until)}</span></li>`).join('')}</ul>`
    : '<p class="none">No break-glass grants yet.</p>';
  $('#page').innerHTML = `
    <h1>Access</h1>
    <p class="sub">Break-glass access gives someone outside ${esc(orgName(state.org))} view and basic service on its trucks for a few minutes, for an incident. It ends by the clock; nothing has to clean it up.</p>
    ${takeFlash()}
    <h2 class="section">Break-glass grants</h2>
    ${grants}
    <div class="grant">
      <select id="bg-person" aria-label="Person">${options(data.candidates)}</select>
      <input id="bg-incident" class="text" value="INC-1042" aria-label="Incident ID" size="9">
      <label class="field">Minutes <input id="bg-minutes" class="text" type="number" min="1" max="60" value="2" aria-label="Minutes" style="width:64px"></label>
      <button type="button" class="btn" data-act="breakglass">Give break-glass access</button>
    </div>`;
}

async function orgsPage() {
  const data = await pageData('/api/organizations');
  if (!data) return;
  if (data.denied) {
    state.flash = null;
    $('#page').innerHTML = `<h1>Organizations</h1><div class="denied"><h1>Only the platform staff manage organizations</h1>
      <p>The PDP denied <code>manage_users</code> on Fleet Ops, the platform operator's organization.</p><p>${esc(data.reason)}</p></div>`;
    return;
  }
  const rows = data.orgs.map((o) => {
    const targets = data.mergeTargets.filter((t) => t.key !== o.key);
    const merge = !o.partner && targets.length
      ? `<select id="merge-${o.key}" aria-label="Merge into">${options(targets)}</select>
         <button type="button" class="btn secondary" data-act="merge" data-key="${o.key}">Merge into</button>`
      : '';
    return `<tr><td><strong>${esc(o.name)}</strong><div class="meta">${esc(o.description)}</div></td><td>${o.trucks ?? 0}</td><td>${o.resources ?? 0}</td><td>${o.assignments ?? 0}</td>
      <td><div class="row-actions"><button type="button" class="btn danger" data-act="delete" data-key="${o.key}">Delete</button>${merge}</div></td></tr>`;
  });
  $('#page').innerHTML = `
    <h1>Organizations</h1>
    <p class="sub">The platform operator's console. Platform staff can delete a customer organization, or merge it into another as a sub-organization. Do these last in a run; <code>make reset</code> brings everything back.</p>
    ${takeFlash()}
    ${rows.length
      ? `<table class="fleet"><thead><tr><th>Organization</th><th>Trucks</th><th>Resources</th><th>Role assignments</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p class="none" style="margin-top:18px">No customer organizations.</p>'}`;
}

async function act(button) {
  if (state.busy) return;
  const action = button.dataset.act;
  const [, kind, key] = route() ?? [];
  const person = action === 'assign' ? $('#give-person')?.value : button.dataset.key;
  const url = {
    truck: `/api/trucks/${key}/act`,
    people: `/api/people/${person}/act`,
    access: '/api/access/act',
    organizations: `/api/organizations/${button.dataset.key}/act`,
  }[kind];
  if (!url) return;
  const params = {
    lane: action === 'dispatch' ? $('#lane')?.value : undefined,
    partner: button.dataset.partner ?? (action === 'grant' ? $('#partner')?.value : undefined),
    site: button.dataset.site ?? (action === 'move' ? $('#move-site')?.value : action === 'transfer' ? $('#transfer-site')?.value : action === 'assign' ? $('#give-site')?.value : undefined),
    person: action === 'breakglass' ? $('#bg-person')?.value : undefined,
    role: button.dataset.role ?? (action === 'assign' ? $('#give-role')?.value : undefined),
    region: action === 'edit_details' ? $('#detail-region')?.value : undefined,
    account: action === 'edit_details' ? $('#detail-account')?.value : undefined,
    certifications: action === 'certify' ? [...document.querySelectorAll(`input[name="cert-${person}"]:checked`)].map((i) => i.value) : undefined,
    incident: action === 'breakglass' ? $('#bg-incident')?.value : undefined,
    minutes: action === 'breakglass' ? Number($('#bg-minutes')?.value) : undefined,
    target: action === 'merge' ? $(`#merge-${button.dataset.key}`)?.value : undefined,
  };
  state.busy = true;
  document.querySelectorAll('#page .btn').forEach((b) => { b.disabled = true; });
  try {
    const res = await api(url, { user: state.user, org: state.org, action, ...params });
    addLog(res.log);
    state.flash = res.ok
      ? { kind: 'ok', text: res.message }
      : { kind: 'error', text: res.denied ? `The PDP denied this. ${res.message}` : res.error };
    if (res.redirect) location.hash = res.redirect;
    await signIn(state.user, state.org); // memberships can change: grants, deleted or merged organizations
    renderSwitchers();
  } catch (err) {
    state.flash = { kind: 'error', text: err.message };
  } finally {
    state.busy = false;
  }
  await render();
}

// PDP log ------------------------------------------------------------------------------------------

function addLog(entries = []) {
  if (!entries.length) return;
  state.log = [...entries.slice().reverse(), ...state.log].slice(0, 200);
  renderLog(entries.length);
}

const valueText = (v) => (v === null || v === undefined ? 'none' : Array.isArray(v) ? v.join(', ') || 'none' : String(v));

function detailHtml(c) {
  const parts = [];
  if (c.route) parts.push(`<p>Relationship route:</p><ol>${c.route.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`);
  if (c.rule) {
    parts.push(`<p>Rule conditions, with the values the PDP evaluated:</p><ul>${c.rule
      .map((r) => `<li><span class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span> ${esc(r.label)} <code>${esc(valueText(r.actual))}</code></li>`)
      .join('')}</ul>`);
  }
  if (c.actingOrg) parts.push(`<p>Tenant isolation: <code>${esc(c.actingOrg)}</code></p>`);
  if (c.fleetRule) parts.push(`<p>Fleet rule that denied: <code>${esc(c.fleetRule)}</code></p>`);
  if (c.grant) parts.push(`<p>Allowed by the custom grant: <code>${esc(c.grant)}</code></p>`);
  if (c.policyVersion) parts.push(`<p>Custom policy version: <code>${esc(c.policyVersion)}</code></p>`);
  return parts.join('');
}

// A denied check in a bulk: the rule conditions that failed, or else the PDP's reason.
function denyWhy(c) {
  if (c.allow) return '';
  const unmet = !c.fleetRule && c.actingOrg !== 'acting_org_mismatch' && c.rule ? c.rule.filter((r) => !r.ok) : [];
  const text = unmet.length ? `Not met: ${unmet.map((r) => `${r.label} (${valueText(r.actual)})`).join('; ')}` : c.reason;
  return text ? `<em>${esc(text)}</em>` : '';
}

function entryHtml(e, fresh) {
  const ms = `${e.ms.toFixed(1)} ms`;
  if (e.kind === 'check') {
    const c = e.calls[0];
    const verdict = c.allow ? 'allow' : 'deny';
    return `<li class="entry ${verdict} ${fresh ? 'fresh' : ''}">
      <div class="entry-head"><span class="v ${verdict}">${c.allow ? 'ALLOW' : 'DENY'}</span><span class="purpose">${esc(e.purpose)}</span><span class="when">${ms}</span></div>
      <code class="call">${esc(e.code)}</code>
      <p class="why ${c.actingOrg === 'acting_org_mismatch' || c.fleetRule ? 'mismatch' : ''}">${esc(c.reason)}</p>
      <details><summary>Why</summary><div class="detail">${detailHtml(c)}
        <details><summary>PDP response</summary><pre>${esc(JSON.stringify(e.debug, null, 2))}</pre></details></div></details>
    </li>`;
  }
  const allowed = e.calls.filter((c) => c.allow).length;
  return `<li class="entry bulk ${fresh ? 'fresh' : ''}">
    <div class="entry-head"><span class="v bulk">${allowed} of ${e.calls.length} allowed</span><span class="purpose">${esc(e.purpose)}</span><span class="when">${ms}</span></div>
    <code class="call">${esc(e.code)}</code>
    <details><summary>Each check</summary><ul class="calls">${e.calls
      .map((c) => `<li class="${c.allow ? 'allow' : 'deny'}" title="${esc(c.code)}"><span class="g">${c.allow ? '✓' : '✗'}</span> ${esc(c.user)} ${esc(c.action)} ${esc(c.resource.type)}:${esc(c.resource.key)} <span class="meta">@${esc(c.resource.tenant)}</span>${denyWhy(c)}</li>`)
      .join('')}</ul></details>
  </li>`;
}

function renderLog(fresh = 0) {
  $('#log').innerHTML = state.log.map((e, i) => entryHtml(e, i < fresh)).join('');
}

async function refreshStatus() {
  let s = { pdp: false, actingOrgRule: false };
  try {
    s = await api('/api/status');
  } catch {
    // shown below as not connected
  }
  $('#status').innerHTML = `
    <span class="${s.pdp ? 'ok' : 'bad'}">${s.pdp ? 'Local PDP connected' : 'PDP not reachable'}</span>
    <span class="${s.actingOrgRule ? 'ok' : 'bad'}">${s.actingOrgRule ? 'Custom rules loaded' : 'Custom rules missing'}</span>`;
}

// Start ----------------------------------------------------------------------------------------------

async function init() {
  state.meta = await api('/api/meta');
  const users = state.meta.users.map((u) => u.key);
  await signIn(users.includes(saved.get('user')) ? saved.get('user') : users[0], saved.get('org'));
  renderSwitchers();
  refreshStatus();
  setInterval(refreshStatus, 15000);

  $('#user').addEventListener('change', async (ev) => {
    await signIn(ev.target.value);
    renderSwitchers();
    await render();
  });
  $('#org').addEventListener('change', async (ev) => {
    state.org = ev.target.value;
    saved.set('org', state.org);
    await render();
  });
  $('#page').addEventListener('click', (ev) => {
    // In the all-organizations list, opening a truck switches to the organization it was checked for.
    const link = ev.target.closest('a[data-org]');
    if (link) {
      state.org = link.dataset.org;
      saved.set('org', state.org);
      renderSwitchers();
    }
    const button = ev.target.closest('[data-act]');
    if (button) act(button);
  });
  $('#log-clear').addEventListener('click', () => {
    state.log = [];
    renderLog();
  });
  window.addEventListener('hashchange', render);
  await render();
}

init().catch((err) => {
  $('#page').innerHTML = `<div class="denied"><h1>Fleet Ops can't start</h1><p>${esc(err.message)}</p></div>`;
});
