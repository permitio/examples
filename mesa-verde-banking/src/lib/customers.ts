import type { DatabaseSync } from 'node:sqlite';

/**
 * What the bank knows about a customer besides their login: the country of their registered address
 * (the "identity provider" data the old demo kept in JSONBin), and where they are now. The old demo
 * looked the location up from the request's IP address; locally every request comes from a private
 * address, so the location is stored here instead.
 */
export interface Customer {
  email: string;
  /** ISO 3166 alpha-2 code of the registered address. */
  country: string;
  /** ISO 3166 alpha-2 code of where the customer is signing in from. */
  location: string;
}

export function migrateCustomers(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS customer (
    email TEXT PRIMARY KEY NOT NULL,
    country TEXT NOT NULL,
    location TEXT NOT NULL
  ) STRICT`);
}

export function upsertCustomer(db: DatabaseSync, customer: Customer): void {
  db.prepare(
    `INSERT INTO customer (email, country, location) VALUES (?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET country = excluded.country, location = excluded.location`,
  ).run(customer.email, customer.country, customer.location);
}

export function findCustomer(db: DatabaseSync, email: string): Customer | undefined {
  const row = db
    .prepare('SELECT email, country, location FROM customer WHERE email = ?')
    .get(email);
  if (row === undefined) return undefined;
  const { email: rowEmail, country, location } = row;
  if (typeof rowEmail !== 'string' || typeof country !== 'string' || typeof location !== 'string') {
    throw new Error(`The customer row for ${email} does not have the expected columns`);
  }
  return { email: rowEmail, country, location };
}
