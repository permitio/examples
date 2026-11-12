import type { City, Meal, Role } from '#shared/types';

/** A demo user that the setup script creates in Permit, with its roles per city. */
export interface Persona {
  key: string;
  roles: Array<{ role: Role; tenant: City }>;
  numberOfRides?: number;
  description: string;
}

export const PERSONAS: readonly Persona[] = [
  {
    key: 'customer1',
    roles: [{ role: 'customer', tenant: 'california' }],
    description: 'Orders meals in California',
  },
  {
    key: 'customer2',
    roles: [{ role: 'customer', tenant: 'washington' }],
    description: 'Orders meals in Washington',
  },
  {
    key: 'vendor1',
    roles: [{ role: 'vendor', tenant: 'california' }],
    description: 'Sells pizza in California',
  },
  {
    key: 'vendor2',
    roles: [{ role: 'vendor', tenant: 'california' }],
    description: 'Sells sushi in California',
  },
  {
    key: 'vendor3',
    roles: [{ role: 'vendor', tenant: 'washington' }],
    description: 'Sells seafood in Washington',
  },
  {
    key: 'rider1',
    roles: [{ role: 'rider', tenant: 'california' }],
    numberOfRides: 120,
    description: 'A new rider in California (120 rides)',
  },
  {
    key: 'rider2',
    roles: [{ role: 'rider', tenant: 'california' }],
    numberOfRides: 650,
    description: 'An experienced rider in California (650 rides)',
  },
  {
    key: 'admin1',
    roles: [
      { role: 'admin', tenant: 'california' },
      { role: 'admin', tenant: 'washington' },
    ],
    description: 'Runs both cities',
  },
];

/** The menu the app starts with. The setup script registers each meal in Permit as well. */
export const SEED_MEALS: readonly Meal[] = [
  {
    id: 'margherita-pizza',
    name: 'Margherita pizza',
    price: 120,
    vendor: 'vendor1',
    city: 'california',
  },
  {
    id: 'party-pizza-box',
    name: 'Party pizza box',
    price: 520,
    vendor: 'vendor1',
    city: 'california',
  },
  { id: 'salmon-nigiri', name: 'Salmon nigiri', price: 180, vendor: 'vendor2', city: 'california' },
  { id: 'miso-soup', name: 'Miso soup', price: 40, vendor: 'vendor2', city: 'california' },
  { id: 'clam-chowder', name: 'Clam chowder', price: 90, vendor: 'vendor3', city: 'washington' },
  { id: 'salmon-dinner', name: 'Salmon dinner', price: 260, vendor: 'vendor3', city: 'washington' },
];
