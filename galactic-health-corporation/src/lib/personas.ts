/**
 * The demo members `pnpm run setup` creates, in the app's database and in Permit. They all share
 * one password; the sign-in page lists them.
 */

export const DEMO_PASSWORD = 'galactic-health';

export interface Persona {
  /** The user key in Better Auth and in Permit. */
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  dateOfBirth: string;
  /** What this member shows in the demo. */
  role: string;
}

export const PERSONAS: readonly Persona[] = [
  {
    id: 'rick',
    email: 'rick@example.com',
    firstName: 'Rick',
    lastName: 'Sanchez',
    phoneNumber: '(555) 010-0001',
    dateOfBirth: '1950-03-04',
    role: 'Member and admin of the Ricks Org and Smith Family groups; in the Benefits pilot group',
  },
  {
    id: 'morty',
    email: 'morty@example.com',
    firstName: 'Morty',
    lastName: 'Smith',
    phoneNumber: '(555) 010-0002',
    dateOfBirth: '2008-05-14',
    role: "Smith Family member and Rick's caregiver: sees Rick's health plan and medical records",
  },
  {
    id: 'birdperson',
    email: 'birdperson@example.com',
    firstName: 'Bird',
    lastName: 'Person',
    phoneNumber: '(555) 010-0003',
    dateOfBirth: '1975-11-02',
    role: 'Ricks Org member; in the Alternative Medicine pilot group',
  },
  {
    id: 'homer',
    email: 'homer@example.com',
    firstName: 'Homer',
    lastName: 'Simpson',
    phoneNumber: '(555) 010-0004',
    dateOfBirth: '1956-05-12',
    role: 'Member in no group: sees only his own data',
  },
];
