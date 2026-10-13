import { BanIcon, EyeIcon, PlugIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/api';
import { ErrorBanner, Notice } from '@/components/ErrorBanner';
import { EmptyNote, Heading, Lede } from '@/components/parts';
import { Button } from '@/components/ui/button';
import { CHANGE_CONFIRMED, useAction, usePersonaName, useResource } from '@/hooks';
import { Fact, PagePlate } from '@/pages/s4/parts';
import { RecentCalls, ScopeTags } from '@/pages/s5/parts';
import { approverOf, type Integration, type IntegrationsResponse, revokeTargets, viewOnlyTargets } from '@/pages/s5/scope';

/**
 * What Sam may do to one integration: the EANs each button changes come from the roles Permit holds for it now, and a button
 * is offered only when it would change something. Already view-only, it offers no "Make view-only"; with no access left, it
 * offers neither, and the scope line says every call is denied.
 */
export function IntegrationCard({ integration, busy, onChange }: { integration: Integration; busy: boolean; onChange: (level: 'read' | 'none') => void }) {
  const nameOf = usePersonaName();
  const approver = approverOf(integration.requests);
  const waiting = integration.requests.some((request) => request.status === 'pending');
  const canMakeViewOnly = viewOnlyTargets(integration.scope).length > 0;
  const canRevoke = revokeTargets(integration.scope).length > 0;
  return (
    <article className="flex flex-col gap-4 rounded-md border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-lg font-extrabold">{integration.name}</h3>
        <code className="font-mono text-sm">{integration.key}</code>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Fact label="Owner">{nameOf(integration.owner)}</Fact>
        <Fact label="Approved by">
          {approver !== undefined ? nameOf(approver) : waiting ? 'Waiting in Approvals' : 'No production access asked for'}
        </Fact>
        <Fact label="Acts for">{integration.customer_name}</Fact>
      </dl>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm text-muted-foreground">What Permit lets it do now</h4>
        <ScopeTags scope={integration.scope} />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm text-muted-foreground">Recent calls</h4>
        <RecentCalls calls={integration.recent} />
      </div>
      {(canMakeViewOnly || canRevoke) && (
        <div className="flex flex-wrap items-center gap-2">
          {canMakeViewOnly && (
            <Button variant="outline" size="lg" disabled={busy} onClick={() => onChange('read')}>
              <EyeIcon data-icon="inline-start" />
              Make view-only
            </Button>
          )}
          {canRevoke && (
            <Button variant="outline" size="lg" disabled={busy} onClick={() => onChange('none')}>
              <BanIcon data-icon="inline-start" />
              Revoke
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * S5's Integrations for Sam, the organization admin: each integration with its owner, approver and scope,
 * to make view-only or revoke. Each button asks Permit for approve_integration on every EAN it changes, then writes the
 * roles, and the page answers once the PDP holds the change.
 */
export function SamIntegrations() {
  const list = useResource<IntegrationsResponse>('/api/s5/integrations');
  const action = useAction();
  const [notice, setNotice] = useState<string>();
  const integrations = list.data?.integrations;

  const change = async (integration: Integration, level: 'read' | 'none') => {
    const eans = level === 'read' ? viewOnlyTargets(integration.scope) : revokeTargets(integration.scope);
    // One change per EAN, in order. A refusal or a failure stops the rest, and a second click takes up what is left.
    const done = await action.run(async () => {
      for (const ean of eans) await api.post<{ ms: number }>(`/api/s5/integrations/${encodeURIComponent(integration.key)}/scope`, { ean, level });
      return true;
    });
    // The notice changes once, when the answer arrives: cleared up front, the page would jump twice.
    setNotice(done ? `${level === 'read' ? `${integration.name} is view-only on ${eans.join(', ')}.` : `${integration.name} no longer has any access.`} ${CHANGE_CONFIRMED}` : undefined);
    list.reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <PagePlate title="Integrations" aside={integrations && { icon: PlugIcon, text: integrations.length === 1 ? '1 integration' : `${integrations.length} integrations` }} />
      <Lede>The integrations acting for your organization: who owns each one, who approved it and what it may do.</Lede>
      <section aria-labelledby="integrations-title" className="flex flex-col gap-3">
        <Heading
          id="integrations-title"
          title="Registered integrations"
          count={integrations?.length}
          action={
            <Button variant="outline" size="lg" onClick={list.reload}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          }
        />
        <ErrorBanner error={action.error} onDismiss={action.clearError} />
        <Notice text={notice} onDismiss={() => setNotice(undefined)} />
        <ErrorBanner error={list.error} />
        {integrations === undefined ? (
          list.error === undefined && <p className="text-muted-foreground">Loading integrations…</p>
        ) : integrations.length === 0 ? (
          <EmptyNote>No integration is registered yet. Pippin registers one on the Integrations page.</EmptyNote>
        ) : (
          integrations.map((integration) => (
            <IntegrationCard key={integration.key} integration={integration} busy={action.busy} onChange={(level) => change(integration, level)} />
          ))
        )}
      </section>
    </div>
  );
}
