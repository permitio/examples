// Small pieces every portal page shares, drawn in the portal's design: a framed note for an
// empty list, the rectangular state tag and a heading with a count badge. Nothing here is red: in the portal a
// refusal reads as information, and red belongs to the Permit panel.

import type { ComponentType, ReactNode, SVGProps } from 'react';
import { cn } from '@/lib/utils';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** A quiet line for an empty list, framed like the list it stands in for. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-border bg-surface px-5 py-4 text-muted-foreground">{children}</p>;
}

export type TagTone = 'go' | 'graphite' | 'outline';

/** A small rectangular state tag, toned like the plates: green when open, graphite or outlined otherwise. */
export function Tag({ tone, icon: TagIcon, label, title }: { tone: TagTone; icon?: Icon; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-bold whitespace-nowrap',
        tone === 'go' && 'bg-go text-on-state',
        tone === 'graphite' && 'border border-plate-edge bg-plate text-on-plate',
        tone === 'outline' && 'border border-foreground',
      )}
    >
      {TagIcon && <TagIcon aria-hidden className="size-4" />}
      {label}
    </span>
  );
}

/** The graphite count badge beside a heading or a tab. */
export function CountBadge({ count, label }: { count: number; label?: string }) {
  return (
    <span
      aria-label={label ?? `${count} ${count === 1 ? 'item' : 'items'}`}
      className="inline-grid h-6 min-w-6 place-items-center rounded-sm border border-plate-edge bg-plate px-1.5 text-sm font-bold text-on-plate"
    >
      {count}
    </span>
  );
}

/** A section heading with an optional count badge and an optional action on the right. */
export function Heading({ id, title, count, action }: { id: string; title: string; count?: number | undefined; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h2 id={id} className="text-xl font-extrabold">
          {title}
        </h2>
        {count !== undefined && <CountBadge count={count} />}
      </div>
      {action}
    </div>
  );
}

/** A page's lede under its sign: one muted sentence. */
export function Lede({ children }: { children: ReactNode }) {
  return <p className="max-w-[70ch] text-base text-muted-foreground">{children}</p>;
}
