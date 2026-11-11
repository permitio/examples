import { Permit } from 'permitio';
import { loadSetupConfig } from '#src/config';
import { describeError, writePolicy } from '#src/write-policy';

/**
 * Writes the example's policy to the Permit environment that PERMIT_API_KEY belongs to. Docker
 * Compose runs it once before the app starts; `pnpm setup-policy` runs it by hand.
 */
try {
  const config = loadSetupConfig();
  console.log(`Writing the policy through ${config.apiUrl}`);
  const permit = new Permit({ token: config.apiKey, apiUrl: config.apiUrl });
  await writePolicy(permit.api, (line) => console.log(`  ${line}`));
  console.log('Policy ready.');
} catch (err) {
  console.error(`Setup failed: ${describeError(err)}`);
  console.error(
    'Check that PERMIT_API_KEY is an environment API key and that PERMIT_API_URL reaches Permit.',
  );
  process.exitCode = 1;
}
