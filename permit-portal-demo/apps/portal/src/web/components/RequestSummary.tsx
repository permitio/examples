// A request as Great Eagle's workflow records it, drawn as the portal's request sign: its facts
// beside a lifecycle strip built from the request's history, with the decision form inside the same frame.

import { CheckIcon, XIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { type Stage, StageStrip } from '@/signs/plates';
import { cn } from '@/lib/utils';
import { formatWhen, REQUEST_TYPE_LABEL, requestDuration, roleWords } from '@/format';
import { usePersonaName } from '@/hooks';
import type { DemoRequest, RequestStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const STAGE_LABEL: Record<RequestStatus, string> = {
  pending: 'Requested',
  approved: 'Approved',
  denied: 'Denied',
  canceled: 'Canceled',
  revoked: 'Revoked',
  expired: 'Expired',
};

/** The account master signs EAN associations off itself (apps/great-eagle-systems/src/store.ts, ACCOUNT_MASTER). */
const SYSTEM_NAMES: Record<string, string> = { 'great-eagle-account-master': 'Great Eagle account master' };

function useNameOf(): (key: string) => string {
  const nameOf = usePersonaName();
  return (key) => SYSTEM_NAMES[key] ?? nameOf(key);
}

/** S5's production request for a connector. */
const isIntegrationAccess = (request: DemoRequest) => request.type === 'integration_access';

/** What the request is called on its card and in its stage strip. */
function titleOf(request: DemoRequest): string {
  return REQUEST_TYPE_LABEL[request.type] ?? request.type;
}

interface Fact {
  label: string;
  value: ReactNode;
  wide?: boolean;
}

const code = (text: string) => <code className="font-mono text-[0.95em]">{text}</code>;

/** A production request reads: the developer who asked, the connector it is for, the EAN and what the connector could do there. */
function integrationFacts(request: DemoRequest, nameOf: (key: string) => string): Fact[] {
  const ean = request.target.startsWith('ean:') ? request.target.slice('ean:'.length) : request.target;
  return [
    { label: 'Developer', value: nameOf(request.initiated_by) },
    { label: 'Connector', value: code(request.requested_for) },
    { label: 'EAN', value: code(ean) },
    { label: 'Actions', value: roleWords(request.role ?? 'integration_client') },
  ];
}

/**
 * The request's lifecycle from its history: Requested, then each decision, with the latest step as the graphite
 * current cell. An undecided request ends on a current "Pending" cell. Never green: in the portal green means only
 * an open gate.
 */
export function RequestStages({ request }: { request: DemoRequest }) {
  const nameOf = useNameOf();
  const pending = request.status === 'pending';
  const last = request.history.length - 1;
  const stages: Stage[] = request.history.map((entry, index) => ({
    label: STAGE_LABEL[entry.status] ?? entry.status,
    detail: `by ${nameOf(entry.by)}`,
    when: formatWhen(entry.at),
    state: !pending && index === last ? 'current' : 'done',
  }));
  if (pending) stages.push({ label: 'Pending', detail: 'Waiting for a decision', state: 'current' });
  return <StageStrip label={`${titleOf(request)} stages`} stages={stages} compact />;
}

/** What, on what, for whom, who started it, why and for how long; actions passed as children sit in the same frame. */
export function RequestSummary({ request, children }: { request: DemoRequest; children?: ReactNode }) {
  const nameOf = useNameOf();
  const duration = requestDuration(request) ?? (request.type === 'collaborator_invite' ? 'set by the approver' : undefined);
  const facts: Fact[] = isIntegrationAccess(request)
    ? integrationFacts(request, nameOf)
    : [
        { label: 'For', value: nameOf(request.requested_for) },
        { label: 'Started by', value: nameOf(request.initiated_by) },
        { label: 'On', value: request.org_name ?? code(request.target) },
      ];
  if (request.reason) facts.push({ label: 'Reason', value: request.reason, wide: true });
  if (duration) facts.push({ label: 'Duration', value: duration });
  if (request.reviewer_comment) facts.push({ label: 'Reviewer comment', value: `"${request.reviewer_comment}"`, wide: true });
  return (
    <article className="flex flex-col gap-3 rounded-md border border-border bg-surface px-5 py-4">
      <h3 className="text-lg font-extrabold">{titleOf(request)}</h3>
      {/* The facts take the card's full width, with the lifecycle strip under them: beside them, next to the decision
          panel, the columns grew too narrow for a name or a target such as shipment:SHP-77001. */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
        {facts.map((fact) => (
          <div key={fact.label} className={cn('flex min-w-0 flex-col', fact.wide && 'sm:col-span-3')}>
            <dt className="text-sm text-muted-foreground">{fact.label}</dt>
            <dd className="font-semibold break-words">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <RequestStages request={request} />
      {children !== undefined && <div className="flex min-w-0 flex-col gap-3">{children}</div>}
    </article>
  );
}

interface DecisionFormProps {
  busy: boolean;
  onDecide: (verdict: 'approve' | 'deny', comment: string, durationMs?: number) => void;
  /** When given, the approver picks how long the access lasts; the first choice is the default. */
  durations?: { label: string; ms: number }[] | undefined;
  /** "Approve", or "Accept" for a nominee accepting an invitation. */
  approveLabel?: string;
  /** False for an invitation the nominee can only accept. */
  canDeny?: boolean;
  /** The reviewer must say why when denying. */
  commentRequiredToDeny?: boolean;
}

/** Approve or deny one request, with a comment that goes on the request record. */
export function RequestDecisionForm({ busy, onDecide, durations, approveLabel = 'Approve', canDeny = true, commentRequiredToDeny = false }: DecisionFormProps) {
  const id = useId();
  const [comment, setComment] = useState('');
  const [durationMs, setDurationMs] = useState(durations?.[0]?.ms);
  const denyBlocked = commentRequiredToDeny && comment.trim() === '';
  const items = durations?.map((d) => ({ value: String(d.ms), label: d.label }));
  return (
    <div className="flex flex-col gap-3">
      {(items || canDeny) && (
        <div className="grid gap-4 sm:grid-cols-[minmax(12rem,auto)_minmax(0,1fr)]">
          {items && (
            <Field>
              <FieldLabel htmlFor={`${id}-lasts`}>Access lasts</FieldLabel>
              <Select
                items={items}
                value={String(durationMs)}
                onValueChange={(value) => {
                  if (value !== null && value !== undefined) setDurationMs(Number(value));
                }}
              >
                <SelectTrigger id={`${id}-lasts`} className="h-9 w-full text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.value} value={item.value} className="text-base">
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {canDeny && (
            <Field className={cn(!items && 'sm:col-span-2')}>
              <FieldLabel htmlFor={`${id}-comment`}>{commentRequiredToDeny ? 'Comment (required to deny)' : 'Comment (optional)'}</FieldLabel>
              <Input id={`${id}-comment`} value={comment} autoComplete="off" className="h-9 text-base md:text-base" onChange={(e) => setComment(e.target.value)} />
            </Field>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="lg" disabled={busy} onClick={() => onDecide('approve', comment, durationMs)}>
          <CheckIcon data-icon="inline-start" />
          {approveLabel}
        </Button>
        {canDeny && (
          <Button size="lg" variant="outline" disabled={busy || denyBlocked} onClick={() => onDecide('deny', comment)}>
            <XIcon data-icon="inline-start" />
            Deny
          </Button>
        )}
      </div>
    </div>
  );
}
