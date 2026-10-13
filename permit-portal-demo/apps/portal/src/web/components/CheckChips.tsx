// Permit's answers and the workflow's states as the portal draws them. In the portal an allowed
// action is a green tag and anything else is graphite or outlined; the red DENY plate belongs to
// the Permit panel (Decision).

import {
  ArrowRightIcon,
  BanIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  TimerOffIcon,
  XIcon,
} from 'lucide-react';
import type { Check, FactItem } from '@/format';
import { useMeta, useNow } from '@/hooks';
import type { Collaborator, RequestStatus } from '@/types';
import { Tag } from '@/components/parts';
import { cn } from '@/lib/utils';

// The same tick as the Countdown beside the chip, so both flip together.
const GRANT_TICK_MS = 250;

/**
 * One Permit decision as the Permit layer shows it: a green ALLOW or red DENY plate, the word
 * always written out.
 */
export function Decision({ allow }: { allow: boolean | undefined }) {
  const label = allow === undefined ? 'NO RESULT' : allow ? 'ALLOW' : 'DENY';
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-sm px-2 py-0.5 font-mono text-xs font-semibold',
        allow === true && 'bg-go text-on-state',
        allow === false && 'bg-stop text-on-state',
        allow === undefined && 'border border-border text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}

/**
 * Permit's answers inside a portal page: each action with its decision written out. An allowed
 * action is a green tag; a denied one is outlined, since red stays in the Permit panel.
 */
export function CheckChips({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {checks.map((check) => (
        <li
          key={check.label}
          className={cn(
            'inline-flex items-center gap-2 rounded-sm px-2.5 py-1 text-sm',
            check.allow === true ? 'bg-go text-on-state' : 'border border-border bg-surface',
          )}
        >
          {check.allow === true ? (
            <ArrowRightIcon aria-hidden className="size-4" />
          ) : (
            <BanIcon aria-hidden className="size-4" />
          )}
          <code className="font-mono font-semibold">{check.label}</code>
          <span className="font-mono text-xs font-semibold">
            {check.allow === undefined ? 'NO RESULT' : check.allow ? 'ALLOW' : 'DENY'}
          </span>
        </li>
      ))}
    </ul>
  );
}

const STATUS_TAG: Record<RequestStatus, { tone: 'graphite' | 'outline'; icon: typeof CheckIcon }> =
  {
    pending: { tone: 'outline', icon: ClockIcon },
    approved: { tone: 'graphite', icon: CheckIcon },
    denied: { tone: 'graphite', icon: XIcon },
    revoked: { tone: 'graphite', icon: BanIcon },
    expired: { tone: 'graphite', icon: TimerOffIcon },
    canceled: { tone: 'outline', icon: CircleDashedIcon },
  };

/** A request's workflow status, as recorded by Great Eagle's systems. */
export function StatusChip({ status }: { status: RequestStatus }) {
  const tag = STATUS_TAG[status] ?? { tone: 'outline' as const, icon: CircleDashedIcon };
  return <Tag tone={tag.tone} icon={tag.icon} label={status} />;
}

/**
 * Whether a collaborator's grant entry is active, as the portal read it from their user record. It
 * turns to "expired" on the same tick as the countdown beside it, rather than at the next page
 * refresh.
 */
export function GrantChip({ collaborator }: { collaborator: Collaborator }) {
  const meta = useMeta();
  const now = useNow(GRANT_TICK_MS);
  if (collaborator.expires === null)
    return <Tag tone="outline" icon={CircleDashedIcon} label="no grant" />;
  const lapsed = collaborator.expires < now + meta.demoClock.offsetMs;
  return collaborator.active && !lapsed ? (
    <Tag tone="go" icon={ArrowRightIcon} label="active" />
  ) : (
    <Tag tone="graphite" icon={TimerOffIcon} label="expired" />
  );
}

/**
 * Trust facts as tags: green with a tick when the fact holds, outlined with a cross when it does
 * not.
 */
export function FactChips({ items, label }: { items: FactItem[]; label: string }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {items.map((item) => (
        <li key={item.key}>
          <Tag
            tone={item.ok ? 'go' : 'outline'}
            icon={item.ok ? CheckIcon : XIcon}
            label={item.text}
          />
        </li>
      ))}
    </ul>
  );
}
