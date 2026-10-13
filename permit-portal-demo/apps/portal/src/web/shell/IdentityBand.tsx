// Permit's purple band across the top: the demo identity switcher, the Permit environment, the demo
// clock and the theme switch. It stands in for Great Eagle's login and says so.

import {
  CheckIcon,
  ChevronsUpDownIcon,
  ClockIcon,
  ExternalLinkIcon,
  MoonIcon,
  ShieldCheckIcon,
  SunIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatOffset } from '@/format';
import type { Theme } from '@/theme';
import type { Meta, Persona } from '@/types';

const CIAM_NOTICE =
  "Demo identity switcher. In production the company's CIAM authenticates users; Permit only authorizes.";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The personas of each scenario, in the order the scenarios meet them; one persona can play in
 * several. Anyone else is listed last.
 */
const GROUPS = [
  { label: 'S4, external collaborator', keys: ['frodo', 'sam', 'aragorn'] },
  { label: 'S1, onboarding and first admin', keys: ['eowyn', 'eomer', 'grima', 'gandalf'] },
  { label: 'S2, delegated administration', keys: ['sam', 'frodo', 'merry'] },
  { label: 'S5, integration', keys: ['pippin', 'sam'] },
  { label: 'S8, migration', keys: ['frodo', 'sam'] },
];

/** The presenter console is the Great Eagle systems mock's own page, on port 4100 of the same host. */
const consoleUrl = () => `${window.location.protocol}//${window.location.hostname}:4100`;

function initials(persona: Persona): string {
  return persona.name
    .split(' ')
    .map((part) => part[0])
    .join('');
}

/** "Title (Company)". A status the seed appends to a company name in brackets is left out. */
function roleLine(persona: Persona): string {
  return `${persona.title} (${persona.company.replace(/\s*\(.*\)$/, '')})`;
}

function Initials({ persona, inverse }: { persona: Persona; inverse?: boolean }) {
  return (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-sm text-xs font-bold',
        inverse ? 'bg-white text-permit' : 'bg-permit text-white',
      )}
    >
      {initials(persona)}
    </span>
  );
}

function groupsOf(personas: Persona[]): Array<{ label: string; personas: Persona[] }> {
  const byKey = new Map(personas.map((p) => [p.key, p]));
  const grouped = GROUPS.map((g) => ({
    label: g.label,
    personas: g.keys.flatMap((k) => byKey.get(k) ?? []),
  }));
  const listed = new Set(GROUPS.flatMap((g) => g.keys));
  const others = personas.filter((p) => !listed.has(p.key));
  return [
    ...grouped,
    ...(others.length > 0 ? [{ label: 'Other personas', personas: others }] : []),
  ].filter((g) => g.personas.length > 0);
}

interface Props {
  meta: Meta;
  persona: string;
  onPersona: (key: string) => void;
  onAdvanceClock: (ms: number) => void;
  onResetClock: () => void;
  clockBusy: boolean;
  theme: Theme;
  onSwitchTheme: () => void;
}

export function IdentityBand({
  meta,
  persona,
  onPersona,
  onAdvanceClock,
  onResetClock,
  clockBusy,
  theme,
  onSwitchTheme,
}: Props) {
  const current = meta.personas.find((p) => p.key === persona);
  const offset = meta.demoClock.offsetMs;
  return (
    <header className="permit permit-band flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-6">
      <span className="flex items-center gap-2 text-lg font-extrabold tracking-tight">
        <ShieldCheckIcon aria-hidden className="size-5" />
        Permit
      </span>
      <p className="order-last w-full text-sm lg:order-none lg:w-auto lg:min-w-0 lg:flex-1">
        {CIAM_NOTICE}
      </p>
      <div className="hidden items-center gap-5 lg:flex">
        {offset !== 0 && (
          <span className="flex items-center gap-1.5 rounded-sm border border-white/70 px-2 py-1 text-sm font-bold">
            <ClockIcon aria-hidden className="size-4" />
            Demo clock: {formatOffset(offset)}
          </span>
        )}
        {/* The demo clock is off by default, and its buttons exist only when it is switched on. */}
        {meta.demoClock.enabled && (
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={clockBusy}
              onClick={() => onAdvanceClock(HOUR_MS)}
            >
              +1 hour
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={clockBusy}
              onClick={() => onAdvanceClock(DAY_MS)}
            >
              +1 day
            </Button>
            <Button variant="ghost" size="sm" disabled={clockBusy} onClick={onResetClock}>
              Reset clock
            </Button>
          </span>
        )}
        <a
          href={consoleUrl()}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-sm font-semibold underline"
        >
          Presenter console
          <ExternalLinkIcon aria-hidden className="size-4" />
        </a>
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2 lg:ml-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Persona"
            render={
              <Button
                variant="ghost"
                className="h-auto min-w-0 shrink justify-between gap-3 rounded-md border border-white/70 py-1.5 pr-3 pl-2 text-left sm:min-w-60"
              />
            }
          >
            {current ? (
              <span className="flex min-w-0 items-center gap-2.5">
                <Initials persona={current} inverse />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate font-bold">{current.name}</span>
                  <span className="text-xs whitespace-normal sm:truncate">{roleLine(current)}</span>
                </span>
              </span>
            ) : (
              <span className="font-bold">Choose a persona</span>
            )}
            <ChevronsUpDownIcon data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="permit w-84">
            {groupsOf(meta.personas).map((group, index) => (
              <DropdownMenuGroup key={group.label}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                {group.personas.map((p) => (
                  <DropdownMenuItem
                    key={p.key}
                    className="justify-between py-1.5"
                    onClick={() => onPersona(p.key)}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Initials persona={p} />
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate font-semibold">{p.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {roleLine(p)}
                        </span>
                      </span>
                    </span>
                    {p.key === persona && (
                      <CheckIcon aria-label="Current persona" className="text-permit-ink" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={onSwitchTheme}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </Button>
      </div>
    </header>
  );
}
