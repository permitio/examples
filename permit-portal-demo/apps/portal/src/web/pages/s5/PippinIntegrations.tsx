import { KeyRoundIcon, PlugIcon, RefreshCwIcon, SendIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, getPersona } from '@/api';
import { SectionHeading } from '@/signs/plates';
import { ErrorBanner, Notice } from '@/components/ErrorBanner';
import { Lede } from '@/components/parts';
import { RequestSummary } from '@/components/RequestSummary';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAction, useResource } from '@/hooks';
import type { DemoRequest } from '@/types';
import { PagePlate } from '../s4/parts';
import { ScopeTags } from './parts';
import { canAskForProduction, type Integration, type IntegrationsResponse, PRODUCTION_EAN, PRODUCTION_REASON, type RegisterResponse } from './scope';

/** The client secret Great Eagle's systems issued, on screen once: it is not stored here, and no later answer carries it. */
function SecretNotice({ name, secret, onDismiss }: { name: string; secret: string; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-foreground bg-surface py-3 pr-2 pl-4">
      <KeyRoundIcon aria-hidden className="mt-0.5 size-5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold">{name} is registered. Its client secret is:</p>
        <code className="font-mono text-sm break-all">{secret}</code>
        <p className="text-muted-foreground">Shown once. Great Eagle's systems hold it for the demo.</p>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}

/** The form that registers an integration: Permit checks register_integration first, and the key and name start filled in. */
function RegisterForm({ onRegistered }: { onRegistered: (registered: RegisterResponse) => void }) {
  const [key, setKey] = useState('shire-erp');
  const [name, setName] = useState('Shire ERP connector');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const registered = await action.run(() => api.post<RegisterResponse>('/api/s5/integrations', { key: key.trim(), name: name.trim() }));
    if (registered) onRegistered(registered);
  };
  return (
    <section aria-labelledby="register-title" className="flex flex-col gap-3">
      <SectionHeading id="register-title" title="Register an integration" />
      <form aria-label="Integration details" onSubmit={submit} className="flex flex-col gap-4 rounded-md border border-border bg-surface px-5 py-4">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="integration-name">Name</FieldLabel>
            <Input id="integration-name" value={name} required className="h-9 text-base md:text-base" onChange={(e) => setName(e.target.value)} />
            <FieldDescription>What Sam and the other approvers see.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="integration-key">Key</FieldLabel>
            <Input id="integration-key" value={key} required className="h-9 font-mono text-base md:text-base" onChange={(e) => setKey(e.target.value)} />
            <FieldDescription>Its identity in Permit: lowercase letters, digits and dashes.</FieldDescription>
          </Field>
        </FieldGroup>
        <p className="text-muted-foreground">A new integration can use the sandbox EAN only. Production access needs an approval.</p>
        <div>
          <Button type="submit" size="lg" disabled={action.busy || key.trim() === '' || name.trim() === ''}>
            <PlugIcon data-icon="inline-start" />
            Register integration
          </Button>
        </div>
      </form>
      <ErrorBanner error={action.error} onDismiss={action.clearError} />
    </section>
  );
}

/** The request for production scope on one EAN, with the reason an approver reads. Both start filled in. */
export function ProductionRequestForm({ integration, onRequested }: { integration: Integration; onRequested: () => void }) {
  const [ean, setEan] = useState(PRODUCTION_EAN);
  const [reason, setReason] = useState(PRODUCTION_REASON);
  // Set once the request is filed: the form goes when the list is read again, and until then it cannot file a second one.
  const [filed, setFiled] = useState(false);
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const request = await action.run(() =>
      api.post<DemoRequest>(`/api/s5/integrations/${encodeURIComponent(integration.key)}/production-requests`, { ean: ean.trim(), reason: reason.trim() }),
    );
    if (request) {
      setFiled(true);
      onRequested();
    }
  };
  return (
    <form aria-label="Production access request" onSubmit={submit} className="flex flex-col gap-4 rounded-md border border-border bg-surface px-5 py-4">
      <h3 className="text-lg font-extrabold">Ask for production access</h3>
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${integration.key}-ean`}>EAN</FieldLabel>
          <Input id={`${integration.key}-ean`} value={ean} required className="h-9 font-mono text-base md:text-base" onChange={(e) => setEan(e.target.value)} />
          <FieldDescription>With approval, {integration.name} can view and create shipments on it.</FieldDescription>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${integration.key}-reason`}>Reason</FieldLabel>
          <Input id={`${integration.key}-reason`} value={reason} required className="h-9 text-base md:text-base" onChange={(e) => setReason(e.target.value)} />
          <FieldDescription>The approver reads it with the request.</FieldDescription>
        </Field>
      </FieldGroup>
      <div>
        <Button type="submit" size="lg" disabled={action.busy || filed || ean.trim() === '' || reason.trim() === ''}>
          <SendIcon data-icon="inline-start" />
          Request production access
        </Button>
      </div>
      <ErrorBanner error={action.error} onDismiss={action.clearError} />
    </form>
  );
}

/** One of Pippin's integrations: what Permit lets it do now, the production request's status card and, when it can be asked, the form. */
function IntegrationSection({ integration, onRequested }: { integration: Integration; onRequested: () => void }) {
  const titleId = `integration-${integration.key}-title`;
  const latest = integration.requests[0];
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <SectionHeading id={titleId} title={integration.name} action={<code className="font-mono text-sm">{integration.key}</code>} />
      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-5 py-4">
        <h3 className="text-sm text-muted-foreground">What Permit lets it do now</h3>
        <ScopeTags scope={integration.scope} />
      </div>
      {latest !== undefined && <RequestSummary request={latest} />}
      {canAskForProduction(integration) && <ProductionRequestForm integration={integration} onRequested={onRequested} />}
    </section>
  );
}

/**
 * S5's Integrations for Pippin, the developer: register the integration with sandbox scope, then ask for
 * production scope and follow the request. Read when it opens and after each action, like Sam's approvals.
 */
export function PippinIntegrations() {
  const me = getPersona();
  const list = useResource<IntegrationsResponse>('/api/s5/integrations');
  const [issued, setIssued] = useState<{ name: string; secret: string }>();
  const [notice, setNotice] = useState<string>();
  const mine = list.data?.integrations.filter((i) => i.owner === me);

  const registered = (r: RegisterResponse) => {
    setIssued({ name: r.integration.name, secret: r.client_secret });
    setNotice(undefined);
    list.reload();
  };
  const requested = () => {
    setNotice("Production access requested. It waits for an organization admin's approval.");
    list.reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <PagePlate title="Integrations" aside={mine && { icon: PlugIcon, text: mine.length === 1 ? '1 integration' : `${mine.length} integrations` }} />
      <Lede>Register an integration that acts for your organization, and ask for the scope it needs.</Lede>
      <ErrorBanner error={list.error} />
      {issued !== undefined && <SecretNotice name={issued.name} secret={issued.secret} onDismiss={() => setIssued(undefined)} />}
      <Notice text={notice} onDismiss={() => setNotice(undefined)} />
      {mine === undefined ? (
        list.error === undefined && <p className="text-muted-foreground">Loading your integrations…</p>
      ) : mine.length === 0 ? (
        <RegisterForm onRegistered={registered} />
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="outline" size="lg" onClick={list.reload}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </div>
          {mine.map((integration) => (
            <IntegrationSection key={integration.key} integration={integration} onRequested={requested} />
          ))}
        </>
      )}
    </div>
  );
}
