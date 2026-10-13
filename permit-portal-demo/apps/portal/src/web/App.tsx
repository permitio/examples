import { RefreshCwIcon } from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useState } from 'react';
import { ApiError, api, DEFAULT_PERSONA, getPersona, setPersona } from '@/api';
import { DecisionPanel } from '@/components/DecisionPanel';
import { ErrorBanner } from '@/components/ErrorBanner';
import { Button } from '@/components/ui/button';
import { MetaContext, useAction, usePortalRebuilt } from '@/hooks';
import { AragornShared } from '@/pages/AragornShared';
import { EowynOnboarding } from '@/pages/EowynOnboarding';
import { Evidence } from '@/pages/Evidence';
import { OrgPage } from '@/pages/OrgPage';
import { FrodoShipments } from '@/pages/FrodoShipments';
import { GandalfQueue } from '@/pages/GandalfQueue';
import { TeamAccess } from '@/pages/s2/TeamAccess';
import { WhatICanDo } from '@/pages/s2/WhatICanDo';
import { PippinIntegrations } from '@/pages/s5/PippinIntegrations';
import { SamIntegrations } from '@/pages/s5/SamIntegrations';
import { SamApprovals } from '@/pages/SamApprovals';
import { EomerInbox } from '@/pages/EomerInbox';
import { IdentityBand } from '@/shell/IdentityBand';
import { type PortalTab, PortalHeader } from '@/shell/PortalHeader';
import { applyTheme, otherTheme, readTheme, saveTheme } from '@/theme';
import type { ClockResponse, Meta } from '@/types';

/** Gríma's pending registration: the impostor organization S1's reviewer denies. */
function GrimaOrganization() {
  return <OrgPage orgKey="riders-of-rohan-llc" />;
}

/** Each persona's pages, in tab order. The first opens when the persona is picked. */
const PAGES: Record<string, Array<{ title: string; Page: ComponentType }>> = {
  frodo: [
    { title: 'Shipments', Page: FrodoShipments },
    { title: 'Team access', Page: TeamAccess },
  ],
  sam: [
    { title: 'Approvals', Page: SamApprovals },
    { title: 'Team access', Page: TeamAccess },
    { title: 'Integrations', Page: SamIntegrations },
  ],
  merry: [{ title: 'What I can do', Page: WhatICanDo }],
  pippin: [{ title: 'Integrations', Page: PippinIntegrations }],
  aragorn: [{ title: 'Shared with you', Page: AragornShared }],
  eowyn: [{ title: 'Your organization', Page: EowynOnboarding }],
  eomer: [{ title: 'Inbox', Page: EomerInbox }],
  gandalf: [{ title: 'Reviews', Page: GandalfQueue }],
  grima: [{ title: 'Your organization', Page: GrimaOrganization }],
};

async function loadMeta(): Promise<Meta> {
  try {
    return await api.get<Meta>('/api/meta');
  } catch (error) {
    // A persona saved in this browser by an older run may not be seeded any more, and the API answers 401 to
    // every call that names it. Fall back to the default persona once rather than stay stuck.
    if (error instanceof ApiError && error.status === 401 && getPersona() !== DEFAULT_PERSONA) {
      setPersona(DEFAULT_PERSONA);
      return api.get<Meta>('/api/meta');
    }
    throw error;
  }
}

/** Shown once the portal was rebuilt after this tab loaded: the old page would call the new API with old code. */
function ReloadBanner() {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-foreground bg-surface px-4 py-2.5 lg:px-6">
      <RefreshCwIcon aria-hidden className="size-5 shrink-0" />
      <p className="min-w-0 flex-1 font-semibold">The portal was updated after this tab opened. Reload the tab to use the new version.</p>
      <Button size="lg" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta>();
  const [metaError, setMetaError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [persona, setPersonaKey] = useState(getPersona);
  const [tab, setTab] = useState<PortalTab>(0);
  const [panelOpen, setPanelOpen] = useState(true);
  const [theme, setTheme] = useState(readTheme);
  const clock = useAction();
  const rebuilt = usePortalRebuilt();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const switchTheme = () => {
    const next = otherTheme(theme);
    saveTheme(next);
    setTheme(next);
  };

  // /api/meta is read once (again only after "Try again", which bumps `attempt`). Afterwards only the demo
  // clock's offset changes, through the clock buttons.
  useEffect(() => {
    let alive = true;
    loadMeta().then(
      (loaded) => {
        if (!alive) return;
        if (!loaded.personas.some((p) => p.key === getPersona()) && loaded.personas[0]) setPersona(loaded.personas[0].key);
        setPersonaKey(getPersona());
        setMeta(loaded);
        setMetaError(undefined);
      },
      (error: unknown) => {
        if (alive) setMetaError(error);
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Changing persona clears page state: the page below is keyed on the persona, so it mounts afresh on their first page.
  const switchPersona = useCallback((key: string) => {
    setPersona(key);
    setPersonaKey(key);
    setTab(0);
  }, []);

  const moveClock = async (path: string, body?: unknown) => {
    const moved = await clock.run(() => api.post<ClockResponse>(path, body));
    if (moved) setMeta((m) => m && { ...m, demoClock: { ...m.demoClock, offsetMs: moved.offsetMs } });
  };

  if (!meta) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-16">
        <h1 className="text-2xl font-black tracking-tight">Great Eagle Logistics Business Portal</h1>
        {metaError === undefined ? (
          <p className="text-muted-foreground">Connecting to the portal…</p>
        ) : (
          <>
            <ErrorBanner error={metaError} />
            <Button size="lg" className="w-fit" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </>
        )}
      </main>
    );
  }

  const pages = PAGES[persona] ?? [];
  const page = tab === 'evidence' ? undefined : pages[tab];
  const firstName = meta.personas.find((p) => p.key === persona)?.name.split(' ')[0] ?? persona;
  return (
    <MetaContext.Provider value={meta}>
      <div className="flex min-h-full flex-col lg:h-full">
        <IdentityBand
          meta={meta}
          persona={persona}
          onPersona={switchPersona}
          onAdvanceClock={(ms) => moveClock('/api/clock/advance', { ms })}
          onResetClock={() => moveClock('/api/clock/reset')}
          clockBusy={clock.busy}
          theme={theme}
          onSwitchTheme={switchTheme}
        />
        {rebuilt && <ReloadBanner />}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main className="min-w-0 flex-1 lg:overflow-y-auto">
            <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-6 pb-10 sm:px-6">
              <PortalHeader titles={pages.length > 0 ? pages.map((p) => p.title) : ['Home']} tab={tab} onTab={setTab} firstName={firstName} />
              <ErrorBanner error={clock.error} onDismiss={clock.clearError} />
              <div key={`${persona}:${tab}`} role="tabpanel">
                {tab === 'evidence' ? <Evidence /> : page ? <page.Page /> : <p className="text-muted-foreground">There is no page for the persona {persona}.</p>}
              </div>
            </div>
          </main>
          <DecisionPanel
            persona={persona}
            personaName={meta.personas.find((p) => p.key === persona)?.name ?? persona}
            open={panelOpen}
            onToggle={() => setPanelOpen((open) => !open)}
          />
        </div>
      </div>
    </MetaContext.Provider>
  );
}
