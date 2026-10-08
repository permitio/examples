import { ArrowRightIcon, DoorClosedIcon, HourglassIcon, PauseIcon, UsersIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { formatClock } from '../src/web/format';
import { gateOf, pathOf, standingOf } from '../src/web/pages/org/standing';
import type { DemoRequest, OrgDetail, RequestStatus, RequestType, TrustFacts } from '../src/web/types';

const NAMES: Record<string, string> = { eowyn: 'Éowyn', eomer: 'Éomer', gandalf: 'Gandalf', grima: 'Gríma Wormtongue' };
const nameOf = (key: string) => NAMES[key] ?? key;
const OK_FACTS: TrustFacts = { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' };

function orgWith(patch: Partial<OrgDetail>): OrgDetail {
  return {
    org: { key: 'riders-of-rohan', name: 'Riders of Rohan' },
    can: {},
    facts: { user: OK_FACTS, ownership_verified: true },
    members: [],
    eans: [],
    requests: [],
    ...patch,
  };
}

let ids = 0;
function request(type: RequestType, status: RequestStatus, fields: Partial<DemoRequest> = {}): DemoRequest {
  const created = fields.created_at ?? '2026-10-06T10:00:00.000Z';
  return {
    id: `req-${++ids}`,
    type,
    tenant: 'riders-of-rohan',
    target: 'organization:riders-of-rohan',
    requested_for: 'eowyn',
    initiated_by: 'eowyn',
    status,
    created_at: created,
    updated_at: fields.updated_at ?? created,
    history: [],
    ...fields,
  };
}

describe('standingOf', () => {
  it('is admin whenever Permit allows manage_members', () => {
    expect(standingOf(orgWith({ can: { manage_members: true, view_own_request: true } }), 'eowyn')).toBe('admin');
  });

  it('is paused when the persona holds org_admin without the power and Great Eagle suspended them', () => {
    const org = orgWith({
      can: { view_profile: true },
      facts: { user: { ...OK_FACTS, risk_state: 'suspended' }, ownership_verified: true },
      members: [{ user: 'eowyn', roles: ['org_admin'] }],
    });
    expect(standingOf(org, 'eowyn')).toBe('paused');
  });

  it('is waiting when the persona holds org_admin without the power for any other reason', () => {
    const members = [{ user: 'eowyn', roles: ['org_admin'] }];
    expect(standingOf(orgWith({ can: { view_profile: true }, members, facts: { user: { ...OK_FACTS, duplicate_check: 'suspected' }, ownership_verified: true } }), 'eowyn')).toBe(
      'waiting',
    );
    expect(standingOf(orgWith({ members, facts: { user: null, ownership_verified: false } }), 'eowyn')).toBe('waiting');
  });

  it("reads only the persona's own roles", () => {
    const org = orgWith({ can: { view_profile: true }, members: [{ user: 'eowyn', roles: ['org_admin'] }, { user: 'eomer', roles: ['org_member'] }] });
    expect(standingOf(org, 'eomer')).toBe('member');
  });

  it('is pending while Permit allows view_own_request, then member, then closed', () => {
    expect(standingOf(orgWith({ can: { view_own_request: true } }), 'eowyn')).toBe('pending');
    expect(standingOf(orgWith({ can: { view_profile: true } }), 'eomer')).toBe('member');
    expect(standingOf(orgWith({ can: { view_profile: false, view_own_request: false } }), 'grima')).toBe('closed');
  });
});

describe('gateOf', () => {
  const name = 'Riders of Rohan';

  it('opens a green gate for an admin, with the sentence the page always had', () => {
    expect(gateOf(orgWith({}), 'eowyn', 'admin', name, nameOf)).toEqual({
      tone: 'go',
      icon: ArrowRightIcon,
      label: 'Open',
      title: 'You manage Riders of Rohan',
      detail: 'Permit allows you to manage Riders of Rohan.',
    });
  });

  it('pauses the gate on a suspension and says Permit denies manage_members, never red', () => {
    expect(gateOf(orgWith({}), 'eowyn', 'paused', name, nameOf)).toEqual({
      tone: 'graphite',
      icon: PauseIcon,
      label: 'Paused',
      title: 'Your admin tools are paused',
      detail: 'You hold the org_admin role, and Permit denies manage_members.',
    });
    expect(gateOf(orgWith({}), 'eowyn', 'waiting', name, nameOf)).toEqual({
      tone: 'graphite',
      icon: HourglassIcon,
      label: 'Pending',
      title: "Your admin tools open after Great Eagle's checks",
      detail: 'You hold the org_admin role, and Permit denies manage_members.',
    });
  });

  it('shows a pending registration as waiting for Great Eagle', () => {
    expect(gateOf(orgWith({}), 'eowyn', 'pending', name, nameOf)).toEqual({
      tone: 'graphite',
      icon: HourglassIcon,
      label: 'Pending',
      title: 'Great Eagle is reviewing your registration',
      detail: "Your request to become the admin of Riders of Rohan is waiting for Great Eagle's review.",
    });
  });

  it("names a member's admins from the role assignments", () => {
    const gate = (members: OrgDetail['members']) => gateOf(orgWith({ members }), 'eomer', 'member', name, nameOf);
    expect(gate([{ user: 'eowyn', roles: ['org_admin'] }, { user: 'eomer', roles: ['org_member'] }])).toEqual({
      tone: 'graphite',
      icon: UsersIcon,
      label: 'Member',
      title: 'You are a member of Riders of Rohan',
      detail: 'Éowyn is its admin.',
    });
    expect(gate([{ user: 'eomer', roles: ['org_member'] }]).detail).toBe('It has no admin right now.');
    expect(gate([{ user: 'eowyn', roles: ['org_admin'] }, { user: 'gandalf', roles: ['org_admin', 'org_member'] }]).detail).toBe(
      'Éowyn and Gandalf are its admins.',
    );
  });

  it('shows nothing from the request records once Permit allows nothing, not even the reviewer\'s comment', () => {
    const refused = request('first_admin', 'denied', { requested_for: 'grima', reviewer: 'gandalf', reviewer_comment: 'duplicate of an existing registration' });
    const org = orgWith({ requests: [refused] });
    expect(gateOf(org, 'grima', 'closed', 'Riders of Rohan LLC', nameOf)).toEqual({
      tone: 'graphite',
      icon: DoorClosedIcon,
      label: 'Closed',
      title: 'You hold no role in Riders of Rohan LLC',
      detail: 'Permit allows you none of the actions on Riders of Rohan LLC.',
    });
    expect(pathOf(org, 'grima', 'closed', nameOf)).toBeUndefined();
  });

  it('closes the gate on no role, or says only "No access" when the persona holds a role Permit gives nothing for', () => {
    expect(gateOf(orgWith({}), 'grima', 'closed', name, nameOf)).toEqual({
      tone: 'graphite',
      icon: DoorClosedIcon,
      label: 'Closed',
      title: 'You hold no role in Riders of Rohan',
      detail: 'Permit allows you none of the actions on Riders of Rohan.',
    });
    expect(gateOf(orgWith({ members: [{ user: 'grima', roles: ['org_member'] }] }), 'grima', 'closed', name, nameOf).title).toBe('No access');
  });

  it('ignores a refused registration that belongs to someone else', () => {
    const refused = request('first_admin', 'denied', { requested_for: 'grima', reviewer: 'gandalf' });
    expect(gateOf(orgWith({ requests: [refused] }), 'eowyn', 'closed', name, nameOf).title).toBe('You hold no role in Riders of Rohan');
  });
});

describe('pathOf', () => {
  const T0 = '2026-10-06T10:00:00.000Z';
  const T1 = '2026-10-06T10:05:00.000Z';
  const T2 = '2026-10-06T10:20:00.000Z';
  const labels = (path: ReturnType<typeof pathOf>) => path?.stages.map((s) => `${s.label}:${s.state}`);

  it('walks a pending registration: registered, Great Eagle review now, admin next', () => {
    const path = pathOf(orgWith({ requests: [request('first_admin', 'pending', { created_at: T0 })] }), 'eowyn', 'pending', nameOf);
    expect(path?.label).toBe('Your registration');
    expect(path?.stages).toEqual([
      { label: 'Registered', detail: `at ${formatClock(T0)}`, state: 'done' },
      { label: 'Great Eagle review', detail: 'Waiting for a reviewer', state: 'current' },
      { label: 'Admin', detail: 'Once Great Eagle approves', state: 'next' },
    ]);
  });

  it('shows no path once Permit allows nothing, and ends a refused registration on Closed for anyone it still lets in', () => {
    const refused = request('first_admin', 'denied', { requested_for: 'grima', created_at: T0, updated_at: T1, reviewer: 'gandalf' });
    const org = orgWith({ requests: [refused] });
    expect(pathOf(org, 'grima', 'closed', nameOf)).toBeUndefined();
    expect(pathOf(org, 'grima', 'member', nameOf)?.stages).toEqual([
      { label: 'Registered', detail: `at ${formatClock(T0)}`, state: 'done' },
      { label: 'Reviewed', detail: `by Gandalf, ${formatClock(T1)}`, state: 'done' },
      { label: 'Closed', detail: `at ${formatClock(T1)}`, state: 'current' },
    ]);
  });

  it("reads the admin stage from the persona's standing", () => {
    const approved = request('first_admin', 'approved', { created_at: T0, updated_at: T1, reviewer: 'gandalf' });
    const org = orgWith({ requests: [approved] });
    expect(pathOf(org, 'eowyn', 'admin', nameOf)?.stages).toEqual([
      { label: 'Registered', detail: `at ${formatClock(T0)}`, state: 'done' },
      { label: 'Approved', detail: `by Gandalf, ${formatClock(T1)}`, state: 'done' },
      { label: 'Admin', detail: `since ${formatClock(T1)}`, state: 'current' },
    ]);
    expect(pathOf(org, 'eowyn', 'paused', nameOf)?.stages.at(-1)?.detail).toBe('Paused');
    expect(pathOf(org, 'eowyn', 'waiting', nameOf)?.stages.at(-1)?.detail).toBe("Waiting on Great Eagle's checks");
  });

  it('adds a waiting handover after the admin stage, and moves to Member once it is accepted', () => {
    const approved = request('first_admin', 'approved', { created_at: T0, updated_at: T1, reviewer: 'gandalf' });
    const handover = (status: RequestStatus) => request('admin_transfer', status, { requested_for: 'eomer', created_at: T1, updated_at: T2 });
    expect(labels(pathOf(orgWith({ requests: [handover('pending'), approved] }), 'eowyn', 'admin', nameOf))).toEqual([
      'Registered:done',
      'Approved:done',
      'Admin:current',
      'Handover:next',
    ]);
    expect(pathOf(orgWith({ requests: [handover('pending'), approved] }), 'eowyn', 'admin', nameOf)?.stages.at(-1)?.detail).toBe('to Éomer, waiting');
    expect(pathOf(orgWith({ requests: [handover('approved'), approved] }), 'eowyn', 'member', nameOf)?.stages.slice(2)).toEqual([
      { label: 'Admin', detail: `until ${formatClock(T2)}`, state: 'done' },
      { label: 'Member', detail: `since ${formatClock(T2)}`, state: 'current' },
    ]);
    expect(labels(pathOf(orgWith({ requests: [handover('denied'), approved] }), 'eowyn', 'admin', nameOf))).toEqual(['Registered:done', 'Approved:done', 'Admin:current']);
  });

  it('walks a membership: invited, joined, then the admin role once nominated', () => {
    const invite = request('member_invite', 'approved', { requested_for: 'eomer', created_at: T0, updated_at: T1 });
    expect(pathOf(orgWith({ requests: [invite] }), 'eomer', 'member', nameOf)).toEqual({
      label: 'Your membership',
      stages: [
        { label: 'Invited', detail: `by Éowyn, ${formatClock(T0)}`, state: 'done' },
        { label: 'Joined', detail: `at ${formatClock(T1)}`, state: 'current' },
        { label: 'Admin', detail: 'If an admin nominates you', state: 'next' },
      ],
    });
    const nominated = request('admin_transfer', 'pending', { requested_for: 'eomer', created_at: T2 });
    expect(pathOf(orgWith({ requests: [nominated, invite] }), 'eomer', 'member', nameOf)?.stages.slice(1)).toEqual([
      { label: 'Joined', detail: `at ${formatClock(T1)}`, state: 'done' },
      { label: 'Admin', detail: 'Nominated by Éowyn', state: 'current' },
    ]);
    const accepted = request('admin_transfer', 'approved', { requested_for: 'eomer', created_at: T1, updated_at: T2 });
    expect(pathOf(orgWith({ requests: [accepted, invite] }), 'eomer', 'admin', nameOf)?.stages.at(-1)).toEqual({
      label: 'Admin',
      detail: `since ${formatClock(T2)}`,
      state: 'current',
    });
  });

  it('ignores invitations that are not accepted yet, and has no path without a request of the persona', () => {
    const pendingInvite = request('member_invite', 'pending', { requested_for: 'eomer' });
    expect(pathOf(orgWith({ requests: [pendingInvite] }), 'eomer', 'closed', nameOf)).toBeUndefined();
    expect(pathOf(orgWith({ requests: [request('first_admin', 'pending')] }), 'eomer', 'closed', nameOf)).toBeUndefined();
  });

  it('follows the newest registration by its time, whatever order the records come in', () => {
    const older = request('first_admin', 'denied', { created_at: T0, updated_at: T0, reviewer: 'gandalf' });
    const newer = request('first_admin', 'pending', { created_at: T2 });
    for (const requests of [
      [older, newer],
      [newer, older],
    ]) {
      expect(labels(pathOf(orgWith({ requests }), 'eowyn', 'pending', nameOf))).toEqual(['Registered:done', 'Great Eagle review:current', 'Admin:next']);
    }
  });
});
