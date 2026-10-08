import { ExternalLinkIcon, HistoryIcon, RefreshCwIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { SectionHeading, SignPlate } from '@/signs/plates';
import { cn } from '@/lib/utils';
import { getPersona } from '../api';
import { StatusChip } from '../components/CheckChips';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyNote } from '../components/parts';
import { RequestSummary } from '../components/RequestSummary';
import { Button, buttonVariants } from '../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { formatWhen } from '../format';
import { useMeta, usePersonaName, useResource } from '../hooks';
import type { DemoRequest } from '../types';

const TENANTS = ['shire-freight', 'riders-of-rohan', 'riders-of-rohan-llc'] as const;
/** Personas of S1 open on its organization; everyone else on Shire Freight, where S4 runs. */
const S1_PERSONAS = new Set(['eowyn', 'eomer', 'grima', 'gandalf']);

const countOf = (n: number) => (n === 1 ? '1 request' : `${n} requests`);

/**
 * One request as the record keeps it: its card, whose stage strip holds every state change with who made it and when.
 * The card shows the decision's comment as the reviewer comment; a comment on any other change is listed beneath.
 */
function RequestRecord({ request }: { request: DemoRequest }) {
  const nameOf = usePersonaName();
  const comments = request.history.filter((entry) => entry.comment && entry.comment !== request.reviewer_comment);
  if (comments.length === 0) return <RequestSummary request={request} />;
  return (
    <RequestSummary request={request}>
      <ul className="flex flex-col gap-1.5" aria-label={`Other comments on request ${request.id}`}>
        {comments.map((entry, i) => (
          <li key={`${entry.at}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <StatusChip status={entry.status} />
            <span className="text-muted-foreground">
              by {nameOf(entry.by)}, {formatWhen(entry.at)}
            </span>
            <q>{entry.comment}</q>
          </li>
        ))}
      </ul>
    </RequestSummary>
  );
}

/**
 * The request history from Great Eagle's workflow (the mock): each request with its lifecycle, every state change, who made
 * it, when, and their comment. Permit's own Audit Log is one click away.
 */
export function Evidence() {
  const meta = useMeta();
  const organizationLabel = useId();
  const [tenant, setTenant] = useState<string>(S1_PERSONAS.has(getPersona()) ? 'riders-of-rohan' : 'shire-freight');
  const history = useResource<DemoRequest[]>(`/api/requests?tenant=${encodeURIComponent(tenant)}`);
  const auditLogUrl = `${meta.permitAppUrl.replace(/\/+$/, '')}/audit`;

  return (
    <div className="flex flex-col gap-6">
      <SignPlate
        id="evidence-title"
        title="Request history"
        aside={history.data === undefined ? undefined : { icon: HistoryIcon, text: countOf(history.data.length) }}
      />
      <div className="-mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <p className="max-w-[60ch] text-muted-foreground">
          Every request as Great Eagle's workflow recorded it. Permit's Audit Log holds each decision with its input; the PDP uploads decisions in batches, so the
          log fills in after the fact rather than live.
        </p>
        <a className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'shrink-0')} href={auditLogUrl} target="_blank" rel="noopener noreferrer">
          Open Permit Audit Log
          <ExternalLinkIcon data-icon="inline-end" />
        </a>
      </div>
      <section aria-labelledby="requests-title" className="flex flex-col gap-3">
        <SectionHeading
          id="requests-title"
          title="Requests, newest first"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <span id={organizationLabel} className="text-sm text-muted-foreground">
                Organization
              </span>
              <ToggleGroup
                aria-labelledby={organizationLabel}
                variant="outline"
                spacing={0}
                className="flex-wrap"
                value={[tenant]}
                onValueChange={(values) => {
                  const next = values[0];
                  if (next !== undefined) setTenant(next);
                }}
              >
                {TENANTS.map((t) => (
                  <ToggleGroupItem
                    key={t}
                    value={t}
                    size="lg"
                    className="px-3 aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground aria-pressed:hover:text-background"
                  >
                    {t}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <Button variant="ghost" size="lg" onClick={history.reload}>
                <RefreshCwIcon data-icon="inline-start" />
                Refresh
              </Button>
            </div>
          }
        />
        <ErrorBanner error={history.error} />
        {history.data === undefined ? (
          history.error === undefined && <p className="text-muted-foreground">Loading the request history…</p>
        ) : history.data.length === 0 ? (
          <EmptyNote>No requests recorded for {tenant} yet.</EmptyNote>
        ) : (
          <ol className="flex flex-col gap-3">
            {history.data.map((request) => (
              <li key={request.id}>
                <RequestRecord request={request} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
