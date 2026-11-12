// Every test file gets a throwaway in-memory database and fixed, fake settings. None of them is a
// real credential.
process.env['DATABASE_PATH'] = ':memory:';
process.env['BETTER_AUTH_SECRET'] = 'test-only-better-auth-secret-0123456789';
process.env['BETTER_AUTH_URL'] = 'http://localhost:3000';
process.env['PERMIT_API_KEY'] = 'test-only-permit-key';
process.env['PERMIT_API_URL'] = 'http://permit.test';
process.env['PERMIT_PDP_URL'] = 'http://pdp.test';
delete process.env['PUBLIC_URL'];
delete process.env['WEBHOOK_SECRET'];
