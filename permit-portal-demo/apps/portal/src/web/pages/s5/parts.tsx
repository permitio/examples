// Pieces S5's two Integrations pages share: what Permit lets a connector do right now, drawn as one
// line per role, and the calls it made, one line each.

import { Tag } from '@/components/parts';
import { formatClock, roleWords } from '@/format';
import type { RecentCall, ScopeEntry } from '@/pages/s5/scope';

/**
 * The roles Permit holds for a connector now, one line each: the role, the resource it is on and
 * what it allows. A connector with none has no access at all, and the line says so: every call it
 * makes is denied.
 */
export function ScopeTags({ scope }: { scope: ScopeEntry[] }) {
  if (scope.length === 0)
    return (
      <p className="text-muted-foreground">
        No access. Permit denies every call the integration makes.
      </p>
    );
  return (
    <ul aria-label="What Permit lets the integration do" className="flex flex-col gap-1.5">
      {scope.map((entry) => (
        <li
          key={`${entry.role}:${entry.resource}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <code className="rounded-sm border border-foreground px-2 py-0.5 font-mono text-sm font-semibold">
            {entry.role}
          </code>
          <code className="font-mono text-sm">{entry.resource}</code>
          <span className="text-sm text-muted-foreground">{roleWords(entry.role)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The calls a connector made, newest first as the portal lists them: when, what it asked, about
 * what, and Permit's answer. An allowed call is a green tag and a denied one is outlined: in the
 * portal red belongs to the Permit panel.
 */
export function RecentCalls({ calls }: { calls: RecentCall[] }) {
  if (calls.length === 0) return <p className="text-muted-foreground">No calls yet.</p>;
  return (
    <ul aria-label="Recent calls" className="flex flex-col gap-1.5">
      {calls.map((call, index) => (
        <li key={`${call.at}:${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-sm text-muted-foreground">{formatClock(call.at)}</span>
          <code className="font-mono text-sm font-semibold">{call.action}</code>
          <code className="font-mono text-sm">{call.resource}</code>
          <Tag tone={call.allow ? 'go' : 'outline'} label={call.allow ? 'Allowed' : 'Denied'} />
        </li>
      ))}
    </ul>
  );
}
