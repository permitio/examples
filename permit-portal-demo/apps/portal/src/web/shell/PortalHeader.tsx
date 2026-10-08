// The portal's own header: its name, a tab for each of the persona's
// pages and the Evidence tab, with a note on what the portal shows.

import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The open tab: one of the persona's pages, by its index in their list, or Evidence. */
export type PortalTab = number | 'evidence';

function Tab({ current, onSelect, children }: { current: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current}
      onClick={onSelect}
      className={cn('-mb-px cursor-pointer border-b-[3px] pb-2 font-bold', current ? 'border-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
    >
      {children}
    </button>
  );
}

export function PortalHeader({ titles, tab, onTab, firstName }: { titles: readonly string[]; tab: PortalTab; onTab: (tab: PortalTab) => void; firstName: string }) {
  const onEvidence = tab === 'evidence';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-black tracking-tight">Great Eagle Logistics</span>
        <span className="text-base text-muted-foreground">Business Portal</span>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border">
        <div role="tablist" aria-label="Pages" className="flex flex-wrap items-end gap-x-6 gap-y-1">
          {titles.map((title, index) => (
            <Tab key={title} current={tab === index} onSelect={() => onTab(index)}>
              {title}
            </Tab>
          ))}
          <Tab current={onEvidence} onSelect={() => onTab('evidence')}>
            Evidence
          </Tab>
        </div>
        <p className="flex items-center gap-1.5 pb-2.5 text-sm text-muted-foreground">
          <InfoIcon aria-hidden className="size-4 shrink-0" />
          {onEvidence ? 'The request record the portal keeps for the demo.' : `The portal shows only what Permit allows ${firstName} to see.`}
        </p>
      </div>
    </div>
  );
}
