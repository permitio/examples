import { Building2Icon } from 'lucide-react';
import { type FormEvent, useCallback, useState } from 'react';
import { type Stage, SignPlate, StageStrip } from '@/signs/plates';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '../api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Lede } from '../components/parts';
import { useAction } from '../hooks';
import type { CreateOrgResponse } from '../types';
import { OrgPage } from './OrgPage';

/** The organization S1 creates live. */
const S1_ORG = 'riders-of-rohan';

/** How registration goes, before there is a request to read it from. */
const REGISTRATION: Stage[] = [
  { label: 'Register', detail: 'Name your organization', state: 'current' },
  { label: 'Great Eagle review', detail: 'A reviewer checks your request', state: 'next' },
  { label: 'Admin', detail: "Once Great Eagle's checks pass", state: 'next' },
];

/** The form that registers the organization, as an inline panel under the page's sign. */
function CreateOrganization({ onCreated }: { onCreated: (key: string) => void }) {
  const [name, setName] = useState('Riders of Rohan');
  const action = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const created = await action.run(() => api.post<CreateOrgResponse>('/api/s1/organizations', { name: name.trim() }));
    if (created) onCreated(created.org?.key ?? S1_ORG);
  };
  return (
    <div className="flex flex-col gap-6">
      <SignPlate id="create-title" title="Create your organization" />
      <Lede>Register your company to manage its accounts and shipments. Great Eagle checks a new organization before anyone becomes its admin.</Lede>
      <StageStrip label="How registration works" stages={REGISTRATION} />
      <form aria-label="Organization details" onSubmit={submit} className="flex flex-col gap-4 rounded-md border border-border bg-surface px-5 py-4">
        <Field className="max-w-md">
          <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
          <Input id="org-name" value={name} required className="h-9 text-base md:text-base" onChange={(e) => setName(e.target.value)} />
          <FieldDescription>Great Eagle's reviewers and your colleagues see this name.</FieldDescription>
        </Field>
        <div>
          <Button type="submit" size="lg" disabled={action.busy || name.trim() === ''}>
            <Building2Icon data-icon="inline-start" />
            Create organization
          </Button>
        </div>
      </form>
      <ErrorBanner error={action.error} onDismiss={action.clearError} />
    </div>
  );
}

/**
 * Éowyn's page. GET /api/s1/organizations/riders-of-rohan decides what Éowyn sees: a 404 means the
 * organization does not exist yet, so Éowyn gets the form to create it; any other answer shows the organization.
 */
export function EowynOnboarding() {
  const [view, setView] = useState<{ kind: 'org'; key: string } | { kind: 'create' }>({ kind: 'org', key: S1_ORG });
  const showCreate = useCallback(() => setView({ kind: 'create' }), []);
  if (view.kind === 'create') return <CreateOrganization onCreated={(key) => setView({ kind: 'org', key })} />;
  return <OrgPage orgKey={view.key} onMissing={showCreate} />;
}
