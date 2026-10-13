// Cargo facts the portal shows on a shipment's sign: display-only data for the demo.
// The seed carries only each shipment's key, EAN, tenant
// and title, and nothing here reaches Permit.

import type { ComponentType, SVGProps } from 'react';
import { StampIcon, TruckIcon } from 'lucide-react';

interface Place {
  code: string;
  city: string;
}

interface ShipmentFacts {
  status: string;
  statusIcon: ComponentType<SVGProps<SVGSVGElement>>;
  origin: Place;
  destination: Place;
  pieces: string;
  weight: string;
  declaredValue: string;
  shipDate: string;
}

const FACTS: Record<string, ShipmentFacts> = {
  'SHP-77001': {
    status: 'Held for customs clearance',
    statusIcon: StampIcon,
    origin: { code: 'HOB', city: 'Hobbiton, the Shire' },
    destination: { code: 'MTI', city: 'Minas Tirith, Gondor' },
    pieces: '4 pallets',
    weight: '1,284 kg',
    declaredValue: 'USD 48,600',
    shipDate: 'Oct 2, 2026',
  },
  'SHP-77002': {
    status: 'In transit',
    statusIcon: TruckIcon,
    origin: { code: 'HOB', city: 'Hobbiton, the Shire' },
    destination: { code: 'BRE', city: 'Bree' },
    pieces: '2 cartons',
    weight: '36 kg',
    declaredValue: 'USD 2,140',
    shipDate: 'Oct 3, 2026',
  },
};

/**
 * The cargo facts for a seeded shipment; undefined for any other key, so the sign shows without
 * them.
 */
export function factsOf(shipment: string): ShipmentFacts | undefined {
  return FACTS[shipment];
}
