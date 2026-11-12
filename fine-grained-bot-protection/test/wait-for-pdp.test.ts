import type { Permit } from 'permitio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermitChecker } from '#src/authorize';
import { differencesFromGrants, PdpNotReadyError, waitForPdp } from '#src/wait-for-pdp';
import { fakePermit } from '#test/fake-permit';

type Checks = Parameters<Permit['bulkCheck']>[0];

/** A PDP that answers every check the same, as one that has no policy or an open one would. */
function answersAll(allowed: boolean): PermitChecker {
  return { bulkCheck: vi.fn(async (checks: Checks) => checks.map(() => allowed)) };
}

/** A PDP running the example's policy, except that it still lets untrusted bots read private items. */
function stillGrantsUntrustedBotsPrivateRead(): PermitChecker {
  const policy = fakePermit();
  return {
    bulkCheck: vi.fn(async (checks: Checks) => {
      const answers = await policy.bulkCheck(checks);
      return checks.map((check, i) => {
        if (typeof check.user === 'string' || typeof check.resource === 'string') return false;
        const untrustedBot = check.user.attributes?.['botType'] === 'LIKELY_AUTOMATED';
        const privateItem = check.resource.attributes?.['private'] === true;
        const own = check.resource.attributes?.['owner'] === check.user.key;
        return (
          (untrustedBot && privateItem && own && check.action === 'read') || answers[i] === true
        );
      });
    }),
  };
}

/** A PDP that answers round `n` from `rounds[n]`, and every round after them from `last`. */
function roundByRound(rounds: readonly PermitChecker[], last: PermitChecker) {
  let calls = 0;
  // Each round asks one bulk check per user set.
  return {
    bulkCheck: vi.fn(async (checks: Checks) => {
      const round = Math.floor(calls / 4);
      calls += 1;
      return (rounds[round] ?? last).bulkCheck(checks);
    }),
  };
}

describe('differencesFromGrants', () => {
  it('finds none when the PDP answers as GRANTS says', async () => {
    expect(await differencesFromGrants(fakePermit())).toEqual([]);
  });

  it('names a grant the PDP still allows', async () => {
    expect(await differencesFromGrants(stillGrantsUntrustedBotsPrivateRead())).toEqual([
      'Untrusted_Bots read on Private Item: allowed, GRANTS denies',
    ]);
  });

  it('names every answer of a PDP without the policy', async () => {
    const differences = await differencesFromGrants(answersAll(false));
    expect(differences).toHaveLength(14);
    expect(differences[0]).toBe('Human_Users read on Public Item: denied, GRANTS allows');
  });
});

describe('waitForPdp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const options = { timeoutMs: 10_000, intervalMs: 1_000 };

  it('returns at once when the PDP already answers as GRANTS says', async () => {
    const log = vi.fn();
    const permit = fakePermit();
    await waitForPdp(permit, log, options);
    expect(permit.bulkCheck).toHaveBeenCalledTimes(4);
    expect(log).not.toHaveBeenCalled();
  });

  it('waits while the PDP answers from the policy it had before', async () => {
    const log = vi.fn();
    const permit = roundByRound(Array(3).fill(answersAll(false)), fakePermit());
    const wait = waitForPdp(permit, log, options);
    await vi.advanceTimersByTimeAsync(3_000);
    await wait;
    expect(permit.bulkCheck).toHaveBeenCalledTimes(16);
    // The same problem is logged once, not every round.
    expect(log.mock.calls).toEqual([
      [
        'waiting for the PDP: 14 of 64 answers differ from GRANTS, such as ' +
          'Human_Users read on Public Item: denied, GRANTS allows',
      ],
    ]);
  });

  it('logs each state once when the PDP goes back to an earlier one', async () => {
    const log = vi.fn();
    const empty = answersAll(false);
    const stale = stillGrantsUntrustedBotsPrivateRead();
    const permit = roundByRound([empty, stale, empty, stale], fakePermit());
    const wait = waitForPdp(permit, log, options);
    await vi.advanceTimersByTimeAsync(4_000);
    await wait;
    expect(permit.bulkCheck).toHaveBeenCalledTimes(20);
    expect(log.mock.calls).toEqual([
      [
        'waiting for the PDP: 14 of 64 answers differ from GRANTS, such as ' +
          'Human_Users read on Public Item: denied, GRANTS allows',
      ],
      [
        'waiting for the PDP: 1 of 64 answers differ from GRANTS, such as ' +
          'Untrusted_Bots read on Private Item: allowed, GRANTS denies',
      ],
    ]);
  });

  it('waits for a revoked grant to be denied', async () => {
    const permit = roundByRound(Array(2).fill(stillGrantsUntrustedBotsPrivateRead()), fakePermit());
    const wait = waitForPdp(permit, vi.fn(), options);
    await vi.advanceTimersByTimeAsync(2_000);
    await wait;
    expect(permit.bulkCheck).toHaveBeenCalledTimes(12);
  });

  it('fails with what the PDP still answers when the time runs out', async () => {
    const wait = waitForPdp(stillGrantsUntrustedBotsPrivateRead(), vi.fn(), options);
    const failed = expect(wait).rejects.toThrow(
      new PdpNotReadyError(
        'The PDP did not apply the policy within 10 s: 1 of 64 answers differ from GRANTS, such ' +
          'as Untrusted_Bots read on Private Item: allowed, GRANTS denies',
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
  });

  it('keeps asking a PDP that does not answer, and says why when the time runs out', async () => {
    const log = vi.fn();
    const permit = {
      bulkCheck: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:7766');
      }),
    };
    const wait = waitForPdp(permit, log, options);
    const failed = expect(wait).rejects.toThrow(
      "The PDP did not apply the policy within 10 s: Permit's PDP did not answer: " +
        'connect ECONNREFUSED 127.0.0.1:7766',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(permit.bulkCheck).toHaveBeenCalledTimes(11);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
