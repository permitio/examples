import { describeError } from '#lib/errors';
import { runSetup } from '#lib/setup';

// Run: pnpm seed, or the Compose `setup` service. Each step prints one line.

try {
  await runSetup((line) => console.log(line));
  console.log('Setup done: the Pink Mobile policy and demo data are in your Permit environment.');
} catch (error) {
  console.error(`Setup failed: ${describeError(error)}`);
  process.exitCode = 1;
}
