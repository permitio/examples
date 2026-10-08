// Proves the PDP enforces the model, and that the demo starts clean. Run: bin/demo preflight <profile>
// (bin/demo first checks that the pdp container runs permitio/pdp-v2:0.9.16.)
import { isDeepStrictEqual } from 'node:util';
import type { Permit } from 'permitio';
import { loadSeed, RESOURCE, type SeedData, TENANT } from '../src/server/model';
import { describeError, httpRequest, scriptPermit, statusOf, syncUser, tenantExists } from './lib/admin';
import { type ScriptEnv, scriptEnv } from './lib/env';
import { ARAGORN, collaboratorFixtures, MATRIX, type MatrixRow, personaAttributes } from './lib/fixtures';
import { decide, describeCheck, pdpHealthStatus, pollUntil } from './lib/pdp';
import { isMain, type Result, runCli } from './lib/report';

export interface RowResult { row: MatrixRow; allow: boolean; witnessAllow?: boolean; matched: boolean }
export interface MatrixResult { ok: boolean; rows: RowResult[]; elapsedMs: number }

async function evaluate(permit: Permit, row: MatrixRow, now: number): Promise<RowResult> {
  const allow = await decide(permit, row, now);
  if (!row.witness) return { row, allow, matched: allow === row.expect };
  const witnessAllow = await decide(permit, { ...row, action: row.witness.action, extra: row.witness.extra }, now);
  return { row, allow, witnessAllow, matched: allow === row.expect && witnessAllow };
}

/**
 * Evaluates every row in one pass and repeats until a whole pass matches or the deadline passes. Rows are never
 * ticked off one by one: a deny seen before the PDP loaded its data would otherwise count as a match.
 */
export async function runMatrix(permit: Permit, opts = { timeoutMs: 120_000, intervalMs: 1_000 }): Promise<MatrixResult> {
  const polled = await pollUntil(async () => {
    const now = Date.now();
    const rows: RowResult[] = [];
    for (const row of MATRIX) rows.push(await evaluate(permit, row, now));
    return rows;
  }, (rows) => rows.every((r) => r.matched), opts);
  return { ok: polled.ok, rows: polled.value, elapsedMs: polled.elapsedMs };
}

export function printMatrix(result: MatrixResult): void {
  const verdict = result.ok ? 'every row matches' : 'some rows still do not match';
  console.log(`Policy matrix, tenant ${TENANT.preflight}: ${verdict} after ${(result.elapsedMs / 1000).toFixed(1)} s`);
  for (const { row, allow, witnessAllow, matched } of result.rows) {
    const note = row.note ? ` [${row.note}]` : '';
    const witness = row.witness ? `; witness ${row.witness.action}: ${witnessAllow ? 'allow' : 'DENY, so the PDP has not loaded this user'}` : '';
    console.log(`  ${matched ? 'ok      ' : 'MISMATCH'} #${String(row.n).padEnd(2)} expect ${(row.expect ? 'allow' : 'deny').padEnd(5)} got ${(allow ? 'allow' : 'deny').padEnd(5)} ${describeCheck(row)}${note}${witness}`);
  }
}

/** The collaborator fixtures' grants are relative to "now", so they are rewritten before every run and never go stale. */
export async function refreshCollaboratorGrants(permit: Permit, now = Date.now()): Promise<void> {
  for (const user of collaboratorFixtures(now)) await syncUser(permit, user);
}

/** What the demo needs at its start. Returns one line per problem; empty means clean. */
export async function checkStartingState(env: ScriptEnv, permit: Permit, seed: SeedData = loadSeed()): Promise<string[]> {
  const problems: string[] = [];
  for (const persona of seed.personas) {
    const expected = personaAttributes(persona);
    let actual: unknown;
    try {
      actual = (await permit.api.users.get(persona.key)).attributes ?? {};
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      problems.push(`persona ${persona.key} does not exist in Permit (run bin/demo seed ${env.profile})`);
      continue;
    }
    if (!isDeepStrictEqual(actual, expected)) problems.push(`${persona.key}'s attributes are ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  // Aragorn holds no grants on the PDP as well: the S4 runner checks Aragorn right after a reset, whose writes reach the PDP asynchronously.
  for (const s of seed.shipments) {
    const view = { user: ARAGORN, action: 'view', type: RESOURCE.shipment, key: s.key, tenant: s.tenant };
    const polled = await pollUntil(() => decide(permit, view), (allow) => !allow, { timeoutMs: 30_000, intervalMs: 500 });
    if (!polled.ok) problems.push(`the PDP still lets ${ARAGORN} view ${RESOURCE.shipment}:${s.key}`);
  }
  if (await tenantExists(permit, TENANT.rohan)) problems.push(`tenant ${TENANT.rohan} exists, but S1 creates it live`);
  for (const request of seed.requests) {
    const res = await httpRequest('GET', `${env.greatEagleSystemsUrl}/api/requests/${encodeURIComponent(request.id)}`, { accept: [404] });
    const status = res.status === 404 ? 'missing' : (res.body as { status?: unknown } | undefined)?.status;
    if (status !== request.status) problems.push(`request ${request.id} is ${String(status)} in the mock, expected ${request.status}`);
  }
  return problems;
}

export async function runPreflight(env: ScriptEnv): Promise<Result> {
  let health: number;
  try {
    health = await pdpHealthStatus(env.pdpUrl);
  } catch (err) {
    return { outcome: 'could-not-run', summary: `the PDP at ${env.pdpUrl} is not reachable (${describeError(err)}); start it with bin/demo up ${env.profile}` };
  }
  if (health !== 200) {
    return { outcome: 'could-not-run',
      summary: `the PDP at ${env.pdpUrl} answered ${health} on GET /healthy; restart the PDP container once and re-run preflight, and if it stays unhealthy, read its logs with bin/demo logs ${env.profile}` };
  }
  console.log(`PDP healthy at ${env.pdpUrl}`);
  console.log(`Profile ${env.profile}, Permit API ${env.apiUrl}`);

  const permit = scriptPermit(env);
  await refreshCollaboratorGrants(permit);
  const matrix = await runMatrix(permit);
  printMatrix(matrix);

  const problems = await checkStartingState(env, permit);
  console.log(problems.length === 0 ? 'Demo starting state: clean' : 'Demo starting state does not match:');
  for (const p of problems) console.log(`  - ${p}`);

  const failures: string[] = [];
  if (!matrix.ok) {
    const rows = matrix.rows.filter((r) => !r.matched).map((r) => `#${r.row.n}`).join(', ');
    failures.push(`policy rows ${rows} do not match; if the PDP holds a stale policy, restart it once and re-run preflight`);
  }
  if (problems.length > 0) failures.push(`the demo starting state does not match; run bin/demo reset ${env.profile}`);
  if (failures.length > 0) return { outcome: 'fail', summary: `preflight ${env.profile}: ${failures.join('. ')}` };
  return { outcome: 'pass', summary: `preflight ${env.profile}: all ${MATRIX.length} policy rows match and the demo starting state is clean` };
}

if (isMain(import.meta.url)) await runCli(() => runPreflight(scriptEnv()));
