/**
 * Made-up health data. Each member gets the same numbers on every request, derived from their user
 * key, so the dashboard looks the same after a reload and in screenshots.
 */

export interface Claim {
  id: string;
  date: string;
  provider: string;
  amount: number;
  status: string;
}

export interface HealthPlan {
  claims: Claim[];
  balance: number;
  deductible: number;
  outOfPocketMax: number;
  claimsPaid: number;
  claimsPending: number;
  claimsDenied: number;
}

export interface MedicalRecords {
  bloodType: string;
  allergies: string[];
}

const CLAIM_STATUSES = ['Claimed', 'Pending', 'Denied'];
const PROVIDERS = ['Dr. Watson', 'Dr. House', 'Dr. Strange', 'Dr. Banner', 'Dr. Grey', 'Dr. Who'];
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const ALLERGIES = ['Peanuts', 'Shellfish', 'Eggs', 'Milk', 'Wheat', 'Soy', 'Tree Nuts', 'Fish'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A seeded pseudo-random generator (mulberry32) returning numbers in [0, 1). */
function generator(seed: string): () => number {
  let state = 0;
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick() needs a non-empty list');
  return item;
}

/** A member's health plan, with up to nine claims from the year before `today`. */
export function healthPlanFor(userKey: string, today = new Date()): HealthPlan {
  const random = generator(`health_plan:${userKey}`);
  const amount = (max: number) => Math.floor(random() * max);
  const claims = Array.from({ length: amount(10) }, (_, index) => ({
    id: `${userKey}-claim-${index + 1}`,
    status: pick(random, CLAIM_STATUSES),
    provider: pick(random, PROVIDERS),
    amount: amount(1000),
    date: new Date(today.getTime() - amount(365) * DAY_MS).toDateString(),
  }));
  return {
    claims,
    balance: amount(10_000),
    deductible: amount(10_000),
    outOfPocketMax: amount(10_000),
    claimsPaid: amount(10_000),
    claimsPending: amount(10_000),
    claimsDenied: amount(10_000),
  };
}

/** A member's blood type and up to four distinct allergies. */
export function medicalRecordsFor(userKey: string): MedicalRecords {
  const random = generator(`medical_records:${userKey}`);
  const bloodType = pick(random, BLOOD_TYPES);
  const count = Math.floor(random() * 5);
  const allergies = new Set<string>();
  while (allergies.size < count) allergies.add(pick(random, ALLERGIES));
  return { bloodType, allergies: [...allergies] };
}
