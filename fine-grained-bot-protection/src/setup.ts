import { Permit } from 'permitio';
import { loadSetupConfig } from '#src/config';
import { PdpNotReadyError, waitForPdp } from '#src/wait-for-pdp';
import { describeError, writePolicy } from '#src/write-policy';

/**
 * Writes the example's policy to the Permit environment that PERMIT_API_KEY belongs to, then waits
 * until the PDP at PERMIT_PDP_URL answers as that policy says. Docker Compose runs it once before
 * the app starts; `pnpm setup-policy` runs it by hand.
 */
try {
  const config = loadSetupConfig();
  console.log(`Writing the policy through ${config.apiUrl}`);
  const permit = new Permit({ token: config.apiKey, apiUrl: config.apiUrl, pdp: config.pdpUrl });
  const log = (line: string) => console.log(`  ${line}`);
  await writePolicy(permit.api, log);
  console.log(`Waiting for the PDP at ${config.pdpUrl} to apply it`);
  await waitForPdp(permit, log);
  console.log('Policy ready.');
} catch (err) {
  console.error(`Setup failed: ${describeError(err)}`);
  console.error(
    err instanceof PdpNotReadyError
      ? 'Check that the PDP runs with an API key of the same environment, and read its logs.'
      : 'Check that PERMIT_API_KEY is an environment API key and that PERMIT_API_URL reaches Permit.',
  );
  process.exitCode = 1;
}
