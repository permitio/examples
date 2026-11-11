import type { UserRead } from 'permitio';

/** Every role assignment and relationship in this example lives in Permit's default tenant. */
export const TENANT = 'default';

/** What a member can share with a caregiver: one Permit resource type each. */
export const SHARING_OPTIONS = ['health_plan', 'medical_records', 'member'] as const;
export type SharingOption = (typeof SHARING_OPTIONS)[number];

export function isSharingOption(value: unknown): value is SharingOption {
  return SHARING_OPTIONS.some((option) => option === value);
}

/** Resource types with one instance per member, keyed `<type>_<user key>`. */
export type MemberResource = 'member' | 'profile' | 'health_plan' | 'medical_records';

/** The instance key of a member's resource, for example `health_plan_rick`. */
export function instanceKey(type: MemberResource, userKey: string): string {
  return `${type}_${userKey}`;
}

/** The `type:key` form Permit uses for a resource instance, for example `member:member_rick`. */
export function instanceOf(type: MemberResource, userKey: string): string {
  return `${type}:${instanceKey(type, userKey)}`;
}

/** The type and owner of a member resource instance (`member:member_rick` → member, rick). */
export function ownerOf(resourceInstance: string): { type: string; owner: string } | undefined {
  const colon = resourceInstance.indexOf(':');
  if (colon <= 0) return undefined;
  const type = resourceInstance.slice(0, colon);
  const key = resourceInstance.slice(colon + 1);
  if (!key.startsWith(`${type}_`) || key.length === type.length + 1) return undefined;
  return { type, owner: key.slice(type.length + 1) };
}

/** A member as the pages show them. */
export interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  dateOfBirth: string;
  relationship: string;
}

/** A caregiver's access to one kind of the signed-in member's data, with its date bounds. */
export interface Caregiver {
  user: Person;
  resource: SharingOption;
  startDate: string;
  endDate: string;
}

/** The body of `POST /api/account/caregiver`. */
export interface CaregiverRequest {
  user: string;
  resource: SharingOption;
  startDate: string;
  endDate: string;
}

/** A member group the signed-in member administers, with its other members. */
export interface MemberGroup {
  key: string;
  name: string;
  members: Person[];
}

/** The window during which a caregiver role holds, as the custom Rego policy reads it. */
export interface CaregiverBounds {
  start_date: string;
  end_date: string;
}

/** Permit's `attributes` field as a plain record (the SDK types it as `object`). */
export function attributesOf(subject: { attributes?: object }): Record<string, unknown> {
  return { ...subject.attributes };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A caregiver's date bounds, by the `type:key` of the resource instance they apply to. */
export function caregiverBoundsOf(user: UserRead): Record<string, CaregiverBounds> {
  const bounds = attributesOf(user)['caregiver_bounds'];
  if (typeof bounds !== 'object' || bounds === null) return {};
  const result: Record<string, CaregiverBounds> = {};
  for (const [instance, value] of Object.entries(bounds)) {
    if (typeof value !== 'object' || value === null) continue;
    const window = value as Record<string, unknown>;
    result[instance] = {
      start_date: text(window['start_date']),
      end_date: text(window['end_date']),
    };
  }
  return result;
}

/** A Permit user as a `Person`. Phone and date of birth come from the user's attributes. */
export function toPerson(user: UserRead, relationship = ''): Person {
  const attributes = attributesOf(user);
  return {
    id: user.key,
    firstName: user.first_name ?? '',
    lastName: user.last_name ?? '',
    email: user.email ?? '',
    phoneNumber: text(attributes['phoneNumber']),
    dateOfBirth: text(attributes['dateOfBirth']),
    relationship,
  };
}
