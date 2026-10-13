import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { couldNotRun, describeError } from '#scripts/lib/admin';

export type Outcome = 'pass' | 'fail' | 'could-not-run';
export interface Result {
  outcome: Outcome;
  summary: string;
}

const EXIT_CODE: Record<Outcome, number> = { pass: 0, fail: 1, 'could-not-run': 2 };
const LABEL: Record<Outcome, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  'could-not-run': 'COULD NOT RUN',
};

/**
 * Prints the outcome and exits: 0 pass, 1 fail, 2 could not run. "Could not run" is never reported
 * as a pass.
 */
export function finish(outcome: Outcome, summary: string): never {
  const line = `\n${LABEL[outcome]}: ${summary}`;
  if (outcome === 'pass') console.log(line);
  else console.error(line);
  process.exit(EXIT_CODE[outcome]);
}

/** The outcome for an error that escaped a script (see couldNotRun). */
export function outcomeOf(err: unknown): Outcome {
  return couldNotRun(err) ? 'could-not-run' : 'fail';
}

/**
 * True when the module at `metaUrl` is the file node was started with, rather than a module another
 * script imported.
 */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

/** Runs a script's main and exits with its outcome. An error that escapes exits 2 or 1, never 0. */
export async function runCli(main: () => Promise<Result>): Promise<never> {
  let result: Result;
  try {
    result = await main();
  } catch (err) {
    result = { outcome: outcomeOf(err), summary: describeError(err) };
  }
  return finish(result.outcome, result.summary);
}
