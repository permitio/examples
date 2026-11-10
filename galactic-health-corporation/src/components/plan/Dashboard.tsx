'use client';

import { Can } from '@casl/react';
import InfoIcon from '@mui/icons-material/Info';
import { Alert, IconButton, Skeleton } from '@mui/material';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { PlanDropdown } from '@/components/plans/PlanDropdown';
import { type UserResource, useUserContext } from '@/contexts/UserContext';
import type { HealthPlan, MedicalRecords } from '@/lib/demo-data';
import type { Person } from '@/lib/resources';

/** Right after sign-up the PDP may not have the new member's data yet; retry this many times. */
const OWN_DASHBOARD_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

const PERSONAL_BENEFITS = [
  ['Gym Membership Discount', '20% off'],
  ['Wellness Program', 'Access to weekly yoga classes'],
  ['Healthcare Shop Discounts', '10% off all products'],
  ['Travel Benefits', 'Free annual health check-ups abroad'],
  ['Nutrition Counseling', 'Monthly session with a nutritionist'],
] as const;

const ALTERNATIVE_MEDICINE = [
  ['Acupuncture', 'We recommend trying acupuncture to help with stress relief.'],
  [
    'Herbal Medicine',
    'Based on your records, certain herbal supplements could improve your sleep quality.',
  ],
  ['Chiropractic Adjustments', 'A series of chiropractic adjustments could ease your back pain.'],
] as const;

interface DashboardData {
  profile: Person | null;
  healthPlan: HealthPlan | null;
  medicalRecords: MedicalRecords | null;
}

/** A JSON response, or null when Permit denied it (403) or the request failed. */
async function fetchAllowed<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const response = await fetch(url, { signal });
  if (response.ok) return (await response.json()) as T;
  if (response.status !== 403) console.error(`${url} answered ${response.status}`);
  return null;
}

async function fetchDashboard(userId: string, signal: AbortSignal): Promise<DashboardData> {
  const [profile, healthPlan, medicalRecords] = await Promise.all([
    fetchAllowed<Person>(`/api/account/profile/${userId}`, signal),
    fetchAllowed<HealthPlan>(`/api/account/dashboard/health-plan/${userId}`, signal),
    fetchAllowed<MedicalRecords>(`/api/account/dashboard/medical-records/${userId}`, signal),
  ]);
  return { profile, healthPlan, medicalRecords };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Loads the dashboard, trying again while Permit denies the profile, up to `attempts` times. */
async function loadDashboard(
  userId: string,
  attempts: number,
  signal: AbortSignal,
): Promise<DashboardData> {
  let data = await fetchDashboard(userId, signal);
  for (let attempt = 1; attempt < attempts && data.profile === null; attempt += 1) {
    await sleep(RETRY_DELAY_MS, signal);
    data = await fetchDashboard(userId, signal);
  }
  return data;
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden bg-white shadow-sm sm:rounded-lg">
      <div className="px-4 py-5 sm:px-6">
        <h3 className="text-lg leading-6 font-medium text-gray-900">{title}</h3>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">{subtitle}</p>
      </div>
      <dl className="border-t border-gray-200 px-4 py-5 sm:px-6">{children}</dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="mt-2 text-sm font-medium text-gray-500 first:mt-0">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{value}</dd>
    </>
  );
}

function InfoButton({ topic }: { topic: string }) {
  return (
    <IconButton
      color="primary"
      aria-label={`More information about ${topic}`}
      onClick={() => window.alert(`More information about ${topic}`)}
    >
      <InfoIcon />
    </IconButton>
  );
}

function PilotGroupFrame({ gradient, children }: { gradient: string; children: ReactNode }) {
  return (
    <div className={`overflow-hidden p-1 shadow-sm sm:rounded-lg ${gradient}`}>
      <div className="h-full w-full rounded-sm bg-white">{children}</div>
    </div>
  );
}

function BenefitsCard() {
  return (
    <PilotGroupFrame gradient="bg-linear-to-r from-pink-500 via-red-500 to-yellow-500">
      <Card title="Personal Benefits" subtitle="Your health benefits for this month">
        {PERSONAL_BENEFITS.map(([name, benefit]) => (
          <Fragment key={name}>
            <dt className="text-sm font-medium text-gray-500">{name}</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {benefit}
              <InfoButton topic={name} />
            </dd>
          </Fragment>
        ))}
      </Card>
    </PilotGroupFrame>
  );
}

function AlternativeMedicineCard() {
  return (
    <PilotGroupFrame gradient="bg-linear-to-r from-green-500 via-purple-500 to-blue-500">
      <Card
        title="Alternative Medicine Recommendations"
        subtitle="Personalized recommendations for alternative treatments"
      >
        {ALTERNATIVE_MEDICINE.map(([name, advice]) => (
          <Fragment key={name}>
            <div className="mt-2 flex items-center justify-between">
              <dt className="text-sm font-medium text-gray-500">{name}</dt>
              <InfoButton topic={name} />
            </div>
            <dd className="mt-1 text-sm text-gray-900">{advice}</dd>
          </Fragment>
        ))}
      </Card>
    </PilotGroupFrame>
  );
}

function ProfileCard({ profile }: { profile: Person }) {
  return (
    <Card title="User Profile" subtitle="Account information">
      <Field label="First Name" value={profile.firstName} />
      <Field label="Last Name" value={profile.lastName} />
      <Field label="Email" value={profile.email} />
      <Field label="Date of Birth" value={profile.dateOfBirth} />
      <Field label="Phone Number" value={profile.phoneNumber} />
    </Card>
  );
}

function MedicalRecordsCard({ records }: { records: MedicalRecords }) {
  return (
    <Card title="Health Information" subtitle="Personal health information">
      <Field label="Blood Type" value={records.bloodType} />
      <Field label="Allergies" value={records.allergies.join(', ') || 'None recorded'} />
    </Card>
  );
}

function HealthPlanCard({ plan }: { plan: HealthPlan }) {
  return (
    <Card title="Health Plan" subtitle="Current health plan details">
      <Field label="Balance" value={`$${plan.balance}`} />
      <Field label="Deductible" value={`$${plan.deductible}`} />
      <Field label="Out of Pocket Max" value={`$${plan.outOfPocketMax}`} />
      <Field label="Claims Paid" value={`$${plan.claimsPaid}`} />
      <Field label="Claims Pending" value={`$${plan.claimsPending}`} />
      <Field label="Claims Denied" value={`$${plan.claimsDenied}`} />
      <dt className="mt-4 border-t border-gray-200 pt-4 text-sm font-medium text-gray-500">
        Claims
      </dt>
      <dd className="mt-1 overflow-x-auto text-sm text-gray-900 sm:flex sm:justify-between">
        {plan.claims.length === 0 ? 'No claims this year' : null}
        {plan.claims.map((claim) => (
          <div key={claim.id} className="mt-2 min-w-[33%] pr-1 sm:mt-0">
            <div className="text-sm text-gray-900">{claim.date}</div>
            <div className="text-sm text-gray-500">
              <span className="text-gray-900">Provider:</span> {claim.provider}
            </div>
            <div className="text-sm text-gray-500">
              <span className="text-gray-900">Amount:</span> {claim.amount}
            </div>
            <div className="text-sm text-gray-500">
              <span className="text-gray-900">Status:</span> {claim.status}
            </div>
          </div>
        ))}
      </dd>
    </Card>
  );
}

function Title({ currentUser, isOwn }: { currentUser: UserResource | null; isOwn: boolean }) {
  if (currentUser === null)
    return <Skeleton variant="text" sx={{ fontSize: '2.5rem' }} width={500} />;
  const name = `${currentUser.firstName} ${currentUser.lastName}`;
  return (
    <h1 className="mb-8 font-semibold text-sky-600">
      {isOwn ? `Welcome, ${name}` : `Viewing ${name}'s Dashboard as a Caregiver`}
    </h1>
  );
}

/**
 * The dashboard of the selected member. Each card is fetched from its own API route, which asks
 * Permit first, so a caregiver sees only the cards they were given. The pilot-group cards are shown
 * by CASL rules that permit-fe-sdk loaded (see `PermissionsProvider`).
 */
export function Dashboard() {
  const { currentUser, loggedInUser } = useUserContext();
  const userId = currentUser?.id;
  const isOwn = userId !== undefined && userId === loggedInUser?.id;
  const [data, setData] = useState<{ userId: string; value: DashboardData } | null>(null);

  useEffect(() => {
    if (userId === undefined) return undefined;
    const controller = new AbortController();
    const retries = isOwn ? OWN_DASHBOARD_RETRIES : 1;
    loadDashboard(userId, retries, controller.signal).then(
      (value) => setData({ userId, value }),
      (error: unknown) => {
        if (!controller.signal.aborted) console.error('Could not load the dashboard', error);
      },
    );
    return () => controller.abort();
  }, [userId, isOwn]);

  const loaded = data !== null && data.userId === userId ? data.value : null;
  const nothingAllowed =
    loaded !== null &&
    loaded.profile === null &&
    loaded.healthPlan === null &&
    loaded.medicalRecords === null;

  return (
    <div className="flex flex-col justify-center p-8">
      <div className="flex flex-col items-center justify-between sm:flex-row">
        <Title currentUser={currentUser} isOwn={isOwn} />
        <PlanDropdown />
      </div>
      {loaded === null ? <Skeleton variant="rectangular" className="w-full" height={500} /> : null}
      {nothingAllowed ? (
        <Alert severity="warning">
          Permit allows none of this dashboard yet. If you just signed up, reload in a few seconds:
          the PDP may still be syncing your data.
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {isOwn ? (
          <>
            <Can I="view" a="benefits_pg">
              <BenefitsCard />
            </Can>
            <Can I="view" a="alt_medicine_pg">
              <AlternativeMedicineCard />
            </Can>
          </>
        ) : null}
        {loaded?.profile ? <ProfileCard profile={loaded.profile} /> : null}
        {loaded?.medicalRecords ? <MedicalRecordsCard records={loaded.medicalRecords} /> : null}
        {loaded?.healthPlan ? <HealthPlanCard plan={loaded.healthPlan} /> : null}
      </div>
    </div>
  );
}
