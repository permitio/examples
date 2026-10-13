// Where a persona stands in an S1 organization and how the page signs it:
// the gate plate, its sentence and the stage strip. Everything is read from GET /api/s1/organizations/:key: the
// standing from Permit's decisions and the role assignments, the stages from the request records Great Eagle keeps.

import { ArrowRightIcon, DoorClosedIcon, HourglassIcon, PauseIcon, UsersIcon } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { PlateTone, Stage } from '@/signs/plates';
import { formatClock } from '@/format';
import type { DemoRequest, OrgDetail } from '@/types';

/**
 * admin: Permit allows manage_members. paused and waiting: the persona holds org_admin but Permit denies it (paused
 * while Great Eagle's risk check is suspended). pending: Permit allows view_own_request, so a registration waits for review.
 * member: Permit allows view_profile. closed: none of these.
 */
export type Standing = 'admin' | 'waiting' | 'paused' | 'pending' | 'member' | 'closed';

export interface Gate {
  tone: PlateTone;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  title: string;
  detail: string;
}

/** The roles a user holds in the organization. */
export function rolesOf(org: OrgDetail, user: string): string[] {
  return org.members.find((m) => m.user === user)?.roles ?? [];
}

/** In the order the page has always decided it: admin power, the admin role without it, a pending request, membership. */
export function standingOf(org: OrgDetail, me: string): Standing {
  if (org.can.manage_members) return 'admin';
  if (rolesOf(org, me).includes('org_admin')) return org.facts.user?.risk_state === 'suspended' ? 'paused' : 'waiting';
  if (org.can.view_own_request) return 'pending';
  if (org.can.view_profile) return 'member';
  return 'closed';
}

/** The newest matching request by when it was made; the API lists newest first, but the order is not relied on. */
function latest(requests: readonly DemoRequest[], match: (request: DemoRequest) => boolean): DemoRequest | undefined {
  return requests.filter(match).reduce<DemoRequest | undefined>((newest, r) => (newest === undefined || Date.parse(r.created_at) > Date.parse(newest.created_at) ? r : newest), undefined);
}

const ownRegistration = (org: OrgDetail, me: string) => latest(org.requests, (r) => r.type === 'first_admin' && r.requested_for === me);

const SUSPENDED = 'You hold the org_admin role, and Permit denies manage_members.';

/** The gate sign for a standing: the plate, a heading, and the sentence the old status banner gave it. */
export function gateOf(org: OrgDetail, me: string, standing: Standing, orgName: string, nameOf: (key: string) => string): Gate {
  switch (standing) {
    case 'admin':
      return { tone: 'go', icon: ArrowRightIcon, label: 'Open', title: `You manage ${orgName}`, detail: `Permit allows you to manage ${orgName}.` };
    case 'paused':
      return { tone: 'graphite', icon: PauseIcon, label: 'Paused', title: 'Your admin tools are paused', detail: SUSPENDED };
    case 'waiting':
      return { tone: 'graphite', icon: HourglassIcon, label: 'Pending', title: "Your admin tools open after Great Eagle's checks", detail: SUSPENDED };
    case 'pending':
      return {
        tone: 'graphite',
        icon: HourglassIcon,
        label: 'Pending',
        title: 'Great Eagle is reviewing your registration',
        detail: `Your request to become the admin of ${orgName} is waiting for Great Eagle's review.`,
      };
    case 'member': {
      const admins = org.members.filter((m) => m.roles.includes('org_admin')).map((m) => nameOf(m.user));
      const detail = admins.length === 0 ? 'It has no admin right now.' : `${admins.join(' and ')} ${admins.length === 1 ? 'is its admin' : 'are its admins'}.`;
      return { tone: 'graphite', icon: UsersIcon, label: 'Member', title: `You are a member of ${orgName}`, detail };
    }
    case 'closed': {
      // Permit allows nothing here, view_own_request included, so nothing from the request records shows either.
      const title = rolesOf(org, me).length === 0 ? `You hold no role in ${orgName}` : 'No access';
      return { tone: 'graphite', icon: DoorClosedIcon, label: 'Closed', title, detail: `Permit allows you none of the actions on ${orgName}.` };
    }
  }
}

function adminDetail(standing: Standing, since: string): string {
  if (standing === 'paused') return 'Paused';
  if (standing === 'waiting') return "Waiting on Great Eagle's checks";
  return `since ${formatClock(since)}`;
}

function registrationStages(org: OrgDetail, me: string, standing: Standing, registration: DemoRequest, nameOf: (key: string) => string): Stage[] {
  const stages: Stage[] = [{ label: 'Registered', detail: `at ${formatClock(registration.created_at)}`, state: 'done' }];
  if (registration.status === 'pending') {
    stages.push({ label: 'Great Eagle review', detail: 'Waiting for a reviewer', state: 'current' }, { label: 'Admin', detail: 'Once Great Eagle approves', state: 'next' });
    return stages;
  }
  const reviewed = `by ${nameOf(registration.reviewer ?? '')}, ${formatClock(registration.updated_at)}`;
  if (registration.status !== 'approved') {
    stages.push({ label: 'Reviewed', detail: reviewed, state: 'done' }, { label: 'Closed', detail: `at ${formatClock(registration.updated_at)}`, state: 'current' });
    return stages;
  }
  stages.push({ label: 'Approved', detail: reviewed, state: 'done' });
  const handover = latest(org.requests, (r) => r.type === 'admin_transfer' && r.initiated_by === me && (r.status === 'pending' || r.status === 'approved'));
  if (handover?.status === 'approved') {
    const at = formatClock(handover.updated_at);
    stages.push({ label: 'Admin', detail: `until ${at}`, state: 'done' }, { label: 'Member', detail: `since ${at}`, state: 'current' });
    return stages;
  }
  stages.push({ label: 'Admin', detail: adminDetail(standing, registration.updated_at), state: 'current' });
  if (handover !== undefined) stages.push({ label: 'Handover', detail: `to ${nameOf(handover.requested_for)}, waiting`, state: 'next' });
  return stages;
}

/** The path that brought the persona here: registering as the first admin, or joining by invitation. */
export function pathOf(org: OrgDetail, me: string, standing: Standing, nameOf: (key: string) => string): { label: string; stages: Stage[] } | undefined {
  // A persona Permit allows nothing here sees none of its request records: the portal shows only what Permit allows.
  if (standing === 'closed') return undefined;
  const registration = ownRegistration(org, me);
  if (registration !== undefined) return { label: 'Your registration', stages: registrationStages(org, me, standing, registration, nameOf) };
  const invitation = latest(org.requests, (r) => r.type === 'member_invite' && r.requested_for === me && r.status === 'approved');
  if (invitation === undefined) return undefined;
  const nomination = latest(org.requests, (r) => r.type === 'admin_transfer' && r.requested_for === me && (r.status === 'pending' || r.status === 'approved'));
  const invited: Stage = { label: 'Invited', detail: `by ${nameOf(invitation.initiated_by)}, ${formatClock(invitation.created_at)}`, state: 'done' };
  const joined = `at ${formatClock(invitation.updated_at)}`;
  if (nomination === undefined) {
    return {
      label: 'Your membership',
      stages: [invited, { label: 'Joined', detail: joined, state: 'current' }, { label: 'Admin', detail: 'If an admin nominates you', state: 'next' }],
    };
  }
  const admin = nomination.status === 'pending' ? `Nominated by ${nameOf(nomination.initiated_by)}` : adminDetail(standing, nomination.updated_at);
  return { label: 'Your membership', stages: [invited, { label: 'Joined', detail: joined, state: 'done' }, { label: 'Admin', detail: admin, state: 'current' }] };
}
