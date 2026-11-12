import { Badge } from '@chakra-ui/react';
import type { Plan } from '#lib/model';

export function PlanBadge({ plan }: { plan: Plan | null }) {
  return <Badge colorPalette={plan === 'VIP' ? 'green' : 'blue'}>{plan ?? 'No plan'}</Badge>;
}
