// Pieces the S4 pages share, drawn in the portal's design: a page's sign plate, the shipment's
// sign, its cargo facts and a labelled fact. The route, status and cargo facts are display-only (c/shipment-facts.ts)
// and are shipment data, so a page shows them only where Permit lets the persona view the shipment.

import { PlaneIcon } from 'lucide-react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { getPersona } from '@/api';
import { SignPlate } from '@/signs/plates';
import { factsOf } from '@/signs/shipment-facts';
import { useMeta } from '@/hooks';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** A page's sign plate: the page's name over the persona's company, with an optional count in its status segment. */
export function PagePlate({ title, aside }: { title: string; aside?: { icon: Icon; text: string } }) {
  const meta = useMeta();
  const company = meta.personas.find((p) => p.key === getPersona())?.company;
  return (
    <SignPlate id="page-title" title={title} aside={aside}>
      {company && <p className="text-lg font-bold">{company}</p>}
    </SignPlate>
  );
}

/**
 * The shipment's sign: its key over its title, then the route and `line`. With `withDetails` it carries the route
 * and the status segment from the cargo facts; a shipment without cargo facts shows without them.
 */
export function ShipmentSign({ shipmentKey, title, line, withDetails }: { shipmentKey: string; title?: string; line?: string; withDetails: boolean }) {
  const facts = withDetails ? factsOf(shipmentKey) : undefined;
  return (
    <SignPlate id="shipment-title" title={shipmentKey} aside={facts && { icon: facts.statusIcon, text: facts.status }}>
      {title && <p className="text-lg font-bold">{title}</p>}
      {(facts || line) && (
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          {facts && (
            <div className="flex items-center gap-4">
              <div className="flex flex-col">
                <span className="text-3xl leading-none font-extrabold">{facts.origin.code}</span>
                <span className="mt-1 text-sm">{facts.origin.city}</span>
              </div>
              <PlaneIcon aria-hidden className="mb-5 size-7 shrink-0" />
              <div className="flex flex-col">
                <span className="text-3xl leading-none font-extrabold">{facts.destination.code}</span>
                <span className="mt-1 text-sm">{facts.destination.city}</span>
              </div>
            </div>
          )}
          {line && <p className="text-base">{line}</p>}
        </div>
      )}
    </SignPlate>
  );
}

/** Four cargo facts between two rules; nothing for a shipment without cargo facts. */
export function CargoFacts({ shipmentKey }: { shipmentKey: string }) {
  const facts = factsOf(shipmentKey);
  if (facts === undefined) return null;
  const items = [
    { label: 'Pieces', value: facts.pieces },
    { label: 'Weight', value: facts.weight },
    { label: 'Declared value', value: facts.declaredValue },
    { label: 'Ship date', value: facts.shipDate },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="text-xl font-bold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One labelled value in a definition list: the label in Slate Ink over the value in bold. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-bold break-words">{children}</dd>
    </div>
  );
}
