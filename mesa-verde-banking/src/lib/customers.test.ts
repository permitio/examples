import { describe, expect, it } from 'vitest';
import { findCustomer, migrateCustomers, upsertCustomer } from '@/lib/customers';
import { openDatabase } from '@/lib/db';

describe('customer table', () => {
  it('stores, updates and finds customers by email', () => {
    const db = openDatabase(':memory:');
    migrateCustomers(db);
    migrateCustomers(db);
    upsertCustomer(db, { email: 'dave@mesaverde.example', country: 'US', location: 'US' });
    upsertCustomer(db, { email: 'dave@mesaverde.example', country: 'US', location: 'FR' });
    expect(findCustomer(db, 'dave@mesaverde.example')).toEqual({
      email: 'dave@mesaverde.example',
      country: 'US',
      location: 'FR',
    });
    expect(findCustomer(db, 'nobody@mesaverde.example')).toBeUndefined();
  });
});
