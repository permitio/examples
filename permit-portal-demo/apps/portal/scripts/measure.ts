// Times checks and changes on the PDP, and writes the timings to a JSON file in results/ (gitignored).
// Run: bin/demo measure <profile> [--checks 1000] [--cycles 50]
// Run it twice: once as is (PDP_DEBUG=True), then restart the PDP with `PDP_DEBUG=False bin/demo up <profile>` and run
// `PDP_DEBUG=False bin/demo measure <profile>`. Compare the two runs to decide whether debug mode stays on.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RESOURCE, ROLE, TENANT } from '../src/server/model';
import { couldNotRun, describeError, ignoreNotFound, scriptPermit, statusOf } from './lib/admin';
import { scriptEnv } from './lib/env';
import { matrixRow, PF_ADMIN_OK } from './lib/fixtures';
import { type CheckSpec, decide, explain, pollUntil } from './lib/pdp';
import { isMain, type Result, runCli } from './lib/report';
import { printMatrix, refreshCollaboratorGrants, runMatrix } from './preflight';

const USAGE = 'usage: bin/demo measure <profile> [--checks N] [--cycles N], where N is a positive whole number';
const LATENCY_KINDS = [{ kind: 'role allow', row: 12 }, { kind: 'attribute allow', row: 6 }, { kind: 'attribute deny', row: 8 }];

interface Stats { n: number; p50: number; p90: number; p99: number; max: number }
interface WriteSample { writeMs: number; status: number; flipped: boolean }

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? Number.NaN;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99), max: sorted.at(-1) ?? Number.NaN };
}

function counts(argv: string[]): { checks: number; cycles: number } | undefined {
  try {
    const { values } = parseArgs({ args: argv, options: { checks: { type: 'string', default: '1000' }, cycles: { type: 'string', default: '50' } } });
    if (!/^\d+$/.test(values.checks) || !/^\d+$/.test(values.cycles)) return undefined;
    const checks = Number(values.checks);
    const cycles = Number(values.cycles);
    return checks > 0 && cycles > 0 ? { checks, cycles } : undefined;
  } catch {
    return undefined;
  }
}

/** Times one write. An HTTP error (424 included) is a sample, not a crash; an unreachable service still stops the run. */
async function timed(write: () => Promise<unknown>): Promise<{ writeMs: number; status: number }> {
  const start = performance.now();
  try {
    await write();
    return { writeMs: performance.now() - start, status: 200 };
  } catch (err) {
    const status = statusOf(err);
    if (status === undefined || couldNotRun(err)) throw err;
    return { writeMs: performance.now() - start, status };
  }
}

async function main(): Promise<Result> {
  const n = counts(process.argv.slice(2));
  if (!n) return { outcome: 'could-not-run', summary: USAGE };
  const env = scriptEnv();
  const permit = scriptPermit(env); // checks, and the normal sync path: writes go straight to the control plane
  const waited = scriptPermit(env, true); // writes through the local PDP, which applies them before it answers
  const startedAt = new Date();

  // The numbers mean something only on a PDP that enforces the model, so measuring starts from a matching matrix.
  await refreshCollaboratorGrants(permit);
  const matrix = await runMatrix(permit);
  if (!matrix.ok) {
    printMatrix(matrix);
    return { outcome: 'could-not-run', summary: `the preflight matrix does not match, so nothing was measured; run bin/demo preflight ${env.profile}` };
  }
  const pdpDebug = process.env.PDP_DEBUG ?? 'True';
  const probe = await explain(env, matrixRow(1));
  const pdpDebugObserved = typeof probe.debug === 'object' && probe.debug !== null;
  if (pdpDebugObserved !== (pdpDebug.toLowerCase() === 'true')) {
    console.warn(`WARN: PDP_DEBUG is ${pdpDebug} in this shell, but the PDP ${pdpDebugObserved ? 'returns' : 'does not return'} a debug block. Label the results by the PDP's actual mode (pdpDebugObserved).`);
  }

  console.log(`Check latency: ${n.checks} sequential checks per kind`);
  const checkLatency = [];
  for (const { kind, row: rowNumber } of LATENCY_KINDS) {
    const row = matrixRow(rowNumber);
    const samplesMs: number[] = [];
    let wrong = 0;
    for (let i = 0; i < n.checks; i++) {
      const start = performance.now();
      const allow = await decide(permit, row);
      samplesMs.push(performance.now() - start);
      if (allow !== row.expect) wrong++;
    }
    checkLatency.push({ kind, row: rowNumber, expect: row.expect ? 'allow' : 'deny', wrong, samplesMs });
  }

  const pending: CheckSpec = { user: 'pf-pending', action: 'view_profile', type: RESOURCE.organization, key: 'pf-org-verified', tenant: TENANT.preflight };
  const membership = { user: pending.user, role: ROLE.orgMember, tenant: TENANT.preflight };
  // Listing first avoids an unassign 404, which the SDK would print as an error on every clean run.
  const dropMembership = async () => {
    // Permit read: whether pf-pending holds the membership (api.roleAssignments.list).
    if ((await permit.api.roleAssignments.list(membership)).length > 0) {
      // Permit write: the membership removed through the PDP, waited (api.roleAssignments.waitForSync().unassign).
      await ignoreNotFound(() => waited.api.roleAssignments.waitForSync(5, 'fail').unassign(membership));
    }
  };
  const adminRow = matrixRow(1);
  const setRisk = (risk_state: string) => ({ attributes: { ...PF_ADMIN_OK.attributes, risk_state } });
  const roleWrites: Array<WriteSample & { op: 'assign' | 'unassign' }> = [];
  const attributeWrites: Array<WriteSample & { to: string }> = [];
  const normalPath: Array<{ to: string; writeMs: number; flipMs: number; flipped: boolean }> = [];
  let risk = 'ok';
  const flipRisk = () => {
    risk = risk === 'ok' ? 'suspended' : 'ok';
    return risk;
  };
  // A change counts as flipped only if the PDP gave the old answer before the write and the new one after it. A
  // failed write (a 424, say) whose target was already the state must not count, so each phase tracks the last answer.
  try {
    console.log(`Waited role writes: ${n.cycles} cycles of assign and unassign ${ROLE.orgMember} for ${pending.user}`);
    await dropMembership();
    const clean = await pollUntil(() => decide(permit, pending), (allow) => !allow, { timeoutMs: 10_000, intervalMs: 100 });
    if (!clean.ok) return { outcome: 'could-not-run', summary: `${pending.user} can still view the profile after removing ${ROLE.orgMember}; run bin/demo seed ${env.profile}` };
    let seesProfile = false;
    for (let i = 0; i < n.cycles; i++) {
      for (const op of ['assign', 'unassign'] as const) {
        const target = op === 'assign';
        const roles = waited.api.roleAssignments.waitForSync(5, 'fail');
        // Permit write: the membership given or taken, through the PDP, waited (api.roleAssignments.assign or unassign).
        const write = await timed(() => (target ? roles.assign(membership) : roles.unassign(membership)));
        const after = await decide(permit, pending);
        roleWrites.push({ op, ...write, flipped: seesProfile !== target && after === target });
        seesProfile = after;
      }
    }

    console.log(`Waited attribute writes: ${n.cycles} flips of ${PF_ADMIN_OK.key} risk_state`);
    let manages = await decide(permit, adminRow);
    for (let i = 0; i < n.cycles; i++) {
      const to = flipRisk();
      const target = to === 'ok';
      // Permit write: the fixture's risk_state flipped through the PDP, waited (api.users.waitForSync().update).
      const write = await timed(() => waited.api.users.waitForSync(5, 'fail').update(PF_ADMIN_OK.key, setRisk(to)));
      const after = await decide(permit, adminRow);
      attributeWrites.push({ to, ...write, flipped: manages !== target && after === target });
      manages = after;
    }

    console.log(`Normal sync path: ${n.cycles} flips written to the control plane, each polled every 10 ms for up to 10 s`);
    for (let i = 0; i < n.cycles; i++) {
      const to = flipRisk();
      const target = to === 'ok';
      const start = performance.now();
      // Permit write: the fixture's risk_state flipped, straight to the control plane (api.users.update).
      await permit.api.users.update(PF_ADMIN_OK.key, setRisk(to));
      const writeMs = performance.now() - start;
      const flip = await pollUntil(() => decide(permit, adminRow), (allow) => allow === target, { timeoutMs: 10_000, intervalMs: 10 });
      normalPath.push({ to, writeMs, flipMs: flip.elapsedMs, flipped: manages !== target && flip.ok });
      manages = flip.value;
    }
  } finally {
    for (const [what, restore] of [
      // Permit write: the fixture put back as it was (api.users.waitForSync().update).
      [`${PF_ADMIN_OK.key} risk_state ok`, () => waited.api.users.waitForSync(5, 'fail').update(PF_ADMIN_OK.key, setRisk('ok'))],
      [`${pending.user} without ${ROLE.orgMember}`, dropMembership],
    ] as const) {
      try {
        await restore();
      } catch (err) {
        console.warn(`WARN: could not restore ${what}: ${describeError(err)}. Run bin/demo seed ${env.profile}.`);
      }
    }
  }

  const summary = {
    checkLatency: checkLatency.map((k) => ({ kind: k.kind, row: k.row, wrong: k.wrong, ...stats(k.samplesMs) })),
    waitedRoleWrites: { ...stats(roleWrites.map((s) => s.writeMs)), notFlipped: roleWrites.filter((s) => !s.flipped).length, http424: roleWrites.filter((s) => s.status === 424).length },
    waitedAttributeWrites: { ...stats(attributeWrites.map((s) => s.writeMs)), notFlipped: attributeWrites.filter((s) => !s.flipped).length, http424: attributeWrites.filter((s) => s.status === 424).length },
    normalPathWrite: stats(normalPath.map((s) => s.writeMs)),
    normalPathFlip: { ...stats(normalPath.filter((s) => s.flipped).map((s) => s.flipMs)), notFlipped: normalPath.filter((s) => !s.flipped).length },
  };
  const writeErrors = [...roleWrites, ...attributeWrites].filter((s) => s.status !== 200 && s.status !== 424).length;

  const fmt = (ms: number) => (Number.isNaN(ms) ? '-' : ms.toFixed(1)).padStart(8);
  const line = (label: string, s: Stats) => console.log(`  ${label.padEnd(46)} ${String(s.n).padStart(5)} ${fmt(s.p50)} ${fmt(s.p90)} ${fmt(s.p99)} ${fmt(s.max)}`);
  console.log(`\nResults for ${env.profile}: PDP_DEBUG ${pdpDebug}, debug block ${pdpDebugObserved ? 'present' : 'absent'} on the PDP`);
  console.log(`  ${'(milliseconds)'.padEnd(46)} ${'n'.padStart(5)} ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}`);
  for (const k of summary.checkLatency) line(`check, ${k.kind} (row ${k.row})`, k);
  line('waited role write (assign or unassign)', summary.waitedRoleWrites);
  line('waited attribute write', summary.waitedAttributeWrites);
  line('normal path: write to the control plane', summary.normalPathWrite);
  line('normal path: write acknowledged -> PDP flip', summary.normalPathFlip);
  const wrong = summary.checkLatency.reduce((sum, k) => sum + k.wrong, 0);
  const notFlipped = summary.waitedRoleWrites.notFlipped + summary.waitedAttributeWrites.notFlipped + summary.normalPathFlip.notFlipped;
  const http424 = summary.waitedRoleWrites.http424 + summary.waitedAttributeWrites.http424;
  console.log(`  wrong decisions ${wrong}, changes that never flipped ${notFlipped}, HTTP 424 ${http424}, other write errors ${writeErrors}`);

  const results = {
    profile: env.profile, apiUrl: env.apiUrl, pdpUrl: env.pdpUrl, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
    args: n, pdpDebug, pdpDebugObserved, summary, checkLatency, waitedRoleWrites: roleWrites, waitedAttributeWrites: attributeWrites, normalPath,
  };
  const dir = new URL('../../../results/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${env.profile.replace(/[^\w-]/g, '_')}-${startedAt.toISOString().replace(/:/g, '-')}.json`, dir);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`Every sample is in ${fileURLToPath(file)}`);

  const problems = wrong + notFlipped + writeErrors;
  return problems === 0
    ? { outcome: 'pass', summary: `measured ${env.profile}` }
    : { outcome: 'fail', summary: `measured ${env.profile}, but ${notFlipped} changes never flipped (${http424} waited writes answered 424), ${wrong} checks answered wrongly and ${writeErrors} other writes failed` };
}

if (isMain(import.meta.url)) await runCli(main);
