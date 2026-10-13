import { ChevronRightIcon, PlaneIcon } from 'lucide-react';
import { useState } from 'react';
import { factsOf } from '@/signs/shipment-facts';
import { ErrorBanner } from '@/components/ErrorBanner';
import { EmptyNote, Heading, Lede } from '@/components/parts';
import { useMeta, useResource } from '@/hooks';
import type { Shipment, ShipmentsResponse } from '@/types';
import { PagePlate } from '@/pages/s4/parts';
import { ShipmentDetail } from '@/pages/ShipmentDetail';

/** One shipment in the list: its key, title, route and EAN; the row opens it. */
function ShipmentRow({ shipment, onOpen }: { shipment: Shipment; onOpen: () => void }) {
  const facts = factsOf(shipment.key);
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer items-center gap-4 px-5 py-4 text-left outline-offset-[-3px] hover:bg-muted"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-3 @2xl:flex-row @2xl:items-center @2xl:gap-6">
          <span className="flex min-w-0 flex-col gap-1.5 @2xl:w-72 @2xl:shrink-0">
            <span className="text-2xl leading-none font-black tracking-tight">{shipment.key}</span>
            <span className="text-sm text-muted-foreground">{shipment.title}</span>
          </span>
          {facts && (
            <span className="flex items-center gap-2 text-lg leading-none font-extrabold">
              {facts.origin.code}
              <PlaneIcon aria-hidden className="size-5" />
              <span className="sr-only">to</span>
              {facts.destination.code}
            </span>
          )}
          <span className="text-muted-foreground @2xl:ml-auto">on {shipment.ean}</span>
        </span>
        <ChevronRightIcon aria-hidden className="size-5 shrink-0" />
      </button>
    </li>
  );
}

/**
 * The shipments Permit lets this persona view (GET /api/s4/shipments filters them); one opens its
 * detail.
 */
export function FrodoShipments() {
  const meta = useMeta();
  const [open, setOpen] = useState<string | null>(null);
  // The list is read only while it is on screen, so an open shipment does not also re-run the list
  // filter.
  const list = useResource<ShipmentsResponse>(open === null ? '/api/s4/shipments' : null);

  if (open !== null) return <ShipmentDetail shipmentKey={open} onBack={() => setOpen(null)} />;

  const shipments = list.data?.shipments;
  return (
    <div className="flex flex-col gap-6">
      <PagePlate title="Shipments" />
      <Lede>Permit filters this list: it shows only the shipments you are allowed to view.</Lede>
      <section aria-labelledby="shipments-title" className="@container flex flex-col gap-3">
        <Heading id="shipments-title" title="Your shipments" count={shipments?.length} />
        <ErrorBanner error={list.error} />
        {shipments === undefined ? (
          list.error === undefined && <p className="text-muted-foreground">Loading shipments…</p>
        ) : shipments.length === 0 ? (
          <EmptyNote>
            Permit allows you to view none of the {meta.shipments.length} shipments.
          </EmptyNote>
        ) : (
          <>
            <p className="text-muted-foreground">
              Permit allows you to view {shipments.length} of {meta.shipments.length} shipments.
            </p>
            <ul className="flex flex-col overflow-hidden rounded-md border border-border bg-surface">
              {shipments.map((s) => (
                <ShipmentRow key={s.key} shipment={s} onOpen={() => setOpen(s.key)} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
