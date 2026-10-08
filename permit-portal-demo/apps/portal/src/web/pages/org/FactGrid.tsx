// Great Eagle's trust facts as the portal draws them: fixed cells on one baseline, a fact
// that holds on the surface with a check, an open one on a graphite plate. Never red.

import { CheckIcon, CircleDashedIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FactItem } from '../../format';

/** Our trustFactItems in a grid of cells: two across, four once the container is wide enough. */
export function FactGrid({ label, items }: { label: string; items: FactItem[] }) {
  return (
    <div className="@container">
      <ul aria-label={label} className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
        {items.map((item) => (
          <li
            key={item.key}
            className={cn(
              'flex items-start gap-1.5 rounded-sm px-3 py-2 font-bold',
              item.ok ? 'border border-border bg-surface' : 'border border-plate-edge bg-plate text-on-plate',
            )}
          >
            {item.ok ? <CheckIcon aria-hidden className="mt-1 size-4 shrink-0" /> : <CircleDashedIcon aria-hidden className="mt-1 size-4 shrink-0" />}
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
