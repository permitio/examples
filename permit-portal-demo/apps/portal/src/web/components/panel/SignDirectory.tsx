// The directory signs at the top of the decision panel: where the
// persona may go, as Permit last answered, in sign green or no-entry red. The red is allowed here: this is Permit's layer.

import { ArrowRightIcon, BanIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DemoEvent } from '@/types';
import { resourceParts, type Sign, type SignAnswer, sharedResources, signsOf } from '@/components/panel/signs';

/**
 * One face of a sign. When several signs name the same resource, the action leads, so one place never reads as both
 * open and closed. `turn` plays the flap: the old face folds away on its top hinge and the new one drops in.
 */
function SignFace({ sign, answer, shared, turn }: { sign: Sign; answer: SignAnswer; shared: boolean; turn?: 'out' | 'in' | undefined }) {
  const { type, key } = resourceParts(sign.resource);
  return (
    <div
      aria-hidden={turn === 'out' || undefined}
      className={cn(
        'flex items-center gap-3 rounded-sm px-4 py-3 text-on-state',
        answer.allow ? 'bg-go' : 'bg-stop',
        turn === 'out' && 'flap-out',
        turn === 'in' && 'flap-in',
      )}
    >
      {answer.allow ? <ArrowRightIcon aria-hidden className="size-6 shrink-0" /> : <BanIcon aria-hidden className="size-6 shrink-0" />}
      {shared ? (
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="font-mono text-lg font-semibold break-all">{sign.action}</span>
          <span className="text-sm [overflow-wrap:anywhere]">{key}</span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-lg font-extrabold [overflow-wrap:anywhere]">{key}</span>
          {type !== undefined && <span className="text-sm">{type}</span>}
        </span>
      )}
      <span className="flex shrink-0 flex-col items-end leading-tight">
        <span className="font-bold">{answer.allow ? 'Open' : 'No entry'}</span>
        <span className="text-sm">
          {shared ? '' : `${sign.action}, `}
          <span className="font-extrabold">check #{answer.id}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * "Where <first name> can go": a sign per action and resource `persona` was checked on since the last "Clear view"
 * (event `after`), with Permit's newest answer. Each face is keyed by the first check of its answer, so a sign turns
 * over once when its answer changes and stays still while re-checks repeat it.
 */
export function SignDirectory({ events, persona, firstName, after }: { events: readonly DemoEvent[]; persona: string; firstName: string; after: number }) {
  const signs = signsOf(events, persona, after);
  const shared = sharedResources(signs);
  return (
    <section aria-labelledby="panel-directory-title" className="flex flex-col gap-3 px-5 pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="panel-directory-title" className="text-lg font-extrabold">
          Where {firstName} can go
        </h3>
        <span className="text-sm text-muted-foreground">From the latest checks</span>
      </div>
      {signs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No checks for {firstName} yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {signs.map((sign) => (
            <li key={sign.key} className="flap">
              {sign.previous && <SignFace key={sign.previous.since} sign={sign} answer={sign.previous} shared={shared.has(sign.resource)} turn="out" />}
              <SignFace key={sign.answer.since} sign={sign} answer={sign.answer} shared={shared.has(sign.resource)} turn={sign.previous ? 'in' : undefined} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
