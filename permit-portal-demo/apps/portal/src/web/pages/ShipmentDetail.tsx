import { ArrowLeftIcon, BrushCleaningIcon, FileTextIcon, RefreshCwIcon, SendIcon, UserMinusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '@/api';
import { CheckChips, GrantChip, StatusChip } from '@/components/CheckChips';
import { Countdown } from '@/components/Countdown';
import { ErrorBanner, Notice } from '@/components/ErrorBanner';
import { EmptyNote, Heading } from '@/components/parts';
import { RequestDecisionForm, RequestSummary } from '@/components/RequestSummary';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { canChecks, formatWhen, requestDuration } from '@/format';
import { CHANGE_CONFIRMED, decideAndConfirm, PAGE_REFRESH_MS, useAction, usePersonaName, useResource } from '@/hooks';
import type { ApprovalsResponse, CleanupStatus, DemoRequest, ShipmentDetail as Detail, Doc, RevokeResponse, ShipmentAction } from '@/types';
import { CargoFacts, ShipmentSign } from '@/pages/s4/parts';

const RENEWAL_LIMIT = 2;
const SHIPMENT_ACTIONS: readonly ShipmentAction[] = [
  'view',
  'upload_docs',
  'invite_collaborator',
  'approve_collaborator',
  'revoke_collaborator',
  'request_renewal',
];
/** External users an account admin may invite; in the demo, the customs broker. */
const EXTERNAL_USERS = ['aragorn'];

/** Invites an external user, in place as a bordered panel. The approver sets the duration. */
function InviteForm({ busy, onInvite }: { busy: boolean; onInvite: (user: string, reason: string) => void }) {
  const nameOf = usePersonaName();
  const [user, setUser] = useState(EXTERNAL_USERS[0] ?? '');
  // Pre-filled so the presenter does not type on a live share; a placeholder looked like a value and was not one.
  const [reason, setReason] = useState('customs clearance');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onInvite(user, reason.trim());
  };
  const people = EXTERNAL_USERS.map((key) => ({ value: key, label: nameOf(key) }));
  return (
    <form
      aria-labelledby="invite-title"
      aria-describedby="invite-description"
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-md border border-border bg-surface px-5 py-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id="invite-title" className="text-lg font-extrabold">
          Invite a collaborator
        </h3>
        <p id="invite-description" className="text-muted-foreground">
          The approver decides how long the access lasts.
        </p>
      </div>
      <FieldGroup className="grid gap-4 sm:grid-cols-[minmax(12rem,auto)_minmax(0,1fr)]">
        <Field>
          <FieldLabel htmlFor="invite-user">User</FieldLabel>
          <Select
            items={people}
            value={user}
            onValueChange={(value) => {
              if (value !== null) setUser(value);
            }}
          >
            <SelectTrigger id="invite-user" className="h-9 w-full text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {people.map((person) => (
                <SelectItem key={person.value} value={person.value} className="text-base">
                  {person.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="invite-reason">Reason</FieldLabel>
          <Input id="invite-reason" value={reason} required autoComplete="off" className="h-9 text-base md:text-base" onChange={(e) => setReason(e.target.value)} />
        </Field>
      </FieldGroup>
      <Button type="submit" size="lg" className="w-fit" disabled={busy || reason.trim() === ''}>
        <SendIcon data-icon="inline-start" />
        Send invitation
      </Button>
    </form>
  );
}

/** Documents as a framed table from 640px and a stacked list below it. */
export function DocumentList({ documents }: { documents: Doc[] }) {
  const nameOf = usePersonaName();
  if (documents.length === 0) return <EmptyNote>No documents yet.</EmptyNote>;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-md border border-border bg-surface sm:block">
        <Table className="text-base">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="px-4 font-bold">
                Document
              </TableHead>
              <TableHead scope="col" className="px-4 font-bold">
                Uploaded by
              </TableHead>
              <TableHead scope="col" className="px-4 text-right font-bold">
                Uploaded
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d, i) => (
              <TableRow key={`${d.name}-${i}`} className="hover:bg-transparent">
                <TableCell className="px-4 py-2.5">
                  <span className="flex items-center gap-2 font-semibold">
                    <FileTextIcon aria-hidden className="size-4 shrink-0" />
                    {d.name}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-2.5">{nameOf(d.by)}</TableCell>
                <TableCell className="px-4 py-2.5 text-right text-muted-foreground">{formatWhen(d.at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col rounded-md border border-border bg-surface sm:hidden">
        {documents.map((d, i) => (
          <li key={`${d.name}-${i}`} className="flex items-start gap-2 border-b border-border px-4 py-3 last:border-b-0">
            <FileTextIcon aria-hidden className="mt-1 size-4 shrink-0" />
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold break-words">{d.name}</span>
              <span className="text-sm text-muted-foreground">
                uploaded by {nameOf(d.by)}, {formatWhen(d.at)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** An invitation still waiting for an approver: the invitee has no access yet. */
function PendingInvitation({ request }: { request: DemoRequest }) {
  const nameOf = usePersonaName();
  const duration = requestDuration(request);
  return (
    <li className="flex flex-col gap-2 border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-lg font-extrabold">{nameOf(request.requested_for)}</span>
          <span className="text-sm text-muted-foreground">{request.requested_for}</span>
        </span>
        <StatusChip status={request.status} />
      </div>
      <p className="text-muted-foreground">
        Invited by {nameOf(request.initiated_by)}
        {duration ? ` for ${duration}` : ''}. No access until an approver approves it.
      </p>
    </li>
  );
}

/** The mock's cleanup job. It sits beside the grants to show that an expired entry is still there until it runs. */
function CleanupLine() {
  const status = useResource<CleanupStatus>('/api/cleanup/status', { refreshMs: PAGE_REFRESH_MS });
  if (status.data === undefined) {
    return status.error === undefined ? (
      <p className="text-sm text-muted-foreground">Cleanup job: reading its status…</p>
    ) : (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Cleanup job status is unavailable.</p>
        <ErrorBanner error={status.error} />
      </div>
    );
  }
  const { lastRunAt, nextRunAt } = status.data;
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <BrushCleaningIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Cleanup job: last run {lastRunAt === null ? 'never' : formatWhen(lastRunAt)}, next run in{' '}
        <Countdown until={nextRunAt} pastLabel="due now" />
        {status.data.lastError && <span className="font-bold text-foreground"> Last run failed: {status.data.lastError}</span>}
      </span>
    </p>
  );
}

export function ShipmentDetail({ shipmentKey, onBack }: { shipmentKey: string; onBack: () => void }) {
  const nameOf = usePersonaName();
  const path = `/api/s4/shipments/${encodeURIComponent(shipmentKey)}`;
  // Read when it opens, after each action, when the tab is shown again and on Refresh, but not on a timer: each read
  // asks Permit six questions, and a timer would fill the Audit Log with checks nobody made.
  const detail = useResource<Detail>(path);
  const action = useAction();
  const [notice, setNotice] = useState<string>();

  const pendingInvitations = detail.data?.requests.filter((r) => r.type === 'collaborator_invite' && r.status === 'pending') ?? [];
  const pendingRenewals = detail.data?.requests.filter((r) => r.type === 'renewal' && r.status === 'pending') ?? [];
  // Which pending renewals this persona may decide is Permit's call (approve_renewal), made by GET /api/approvals.
  // It is read only while a renewal is pending here, and again whenever that set changes.
  const approvals = useResource<ApprovalsResponse>(pendingRenewals.length > 0 ? '/api/approvals' : null, {
    key: pendingRenewals.map((r) => r.id).join(','),
  });

  const decide = async (id: string, verdict: 'approve' | 'deny', comment: string) => {
    await decideAndConfirm(action.run, setNotice, id, verdict, comment);
    detail.reload();
  };

  const invite = async (user: string, reason: string) => {
    const created = await action.run(() => api.post<DemoRequest>(`${path}/invitations`, { user, reason }));
    setNotice(created ? `Invitation sent to ${nameOf(user)}. Access starts once an approver approves it and sets how long it lasts.` : undefined);
    if (created) detail.reload();
  };

  const revoke = async (user: string) => {
    const revoked = await action.run(() => api.post<RevokeResponse>(`${path}/revoke`, { user }));
    setNotice(revoked ? `Revoked ${nameOf(user)}'s access. ${CHANGE_CONFIRMED}` : undefined);
    detail.reload();
  };

  const data = detail.data;
  const can = data?.can;
  const busy = action.busy;
  const canDecide = (id: string) => approvals.data?.requests.some((r) => r.id === id) ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="flex w-fit cursor-pointer items-center gap-1.5 font-bold underline-offset-4 hover:underline">
          <ArrowLeftIcon aria-hidden className="size-4" />
          Back to shipments
        </button>
        <Button variant="outline" size="lg" onClick={detail.reload}>
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <ShipmentSign
        shipmentKey={shipmentKey}
        title={data?.shipment.title}
        line={data && `on ${data.shipment.ean}, ${data.shipment.tenant}`}
        withDetails={can?.view === true}
      />
      <ErrorBanner error={action.error} onDismiss={action.clearError} />
      <Notice text={notice} onDismiss={() => setNotice(undefined)} />
      <ErrorBanner error={detail.error} />
      {data === undefined ? (
        detail.error === undefined && <p className="text-muted-foreground">Loading the shipment…</p>
      ) : (
        <>
          {can?.view && <CargoFacts shipmentKey={shipmentKey} />}

          <section aria-labelledby="allowed-title" className="flex flex-col gap-3">
            <Heading id="allowed-title" title="What Permit allows you on this shipment" />
            <CheckChips label="Permit decisions for this shipment" checks={canChecks(can, SHIPMENT_ACTIONS)} />
          </section>

          <section aria-labelledby="collaborators-title" className="flex flex-col gap-3">
            <Heading id="collaborators-title" title="Collaborators" />
            {can?.invite_collaborator && <InviteForm busy={busy} onInvite={invite} />}
            {data.collaborators.length === 0 && pendingInvitations.length === 0 && (
              <EmptyNote>No collaborators yet. An invitation gives access only after an approver approves it.</EmptyNote>
            )}
            {data.collaborators.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border bg-surface">
                <Table className="text-base">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className="px-4 font-bold">
                        Collaborator
                      </TableHead>
                      <TableHead scope="col" className="px-4 font-bold">
                        Access ends
                      </TableHead>
                      <TableHead scope="col" className="px-4 font-bold">
                        Time left
                      </TableHead>
                      <TableHead scope="col" className="px-4 font-bold">
                        Renewals used
                      </TableHead>
                      <TableHead scope="col" className="px-4 font-bold">
                        Status
                      </TableHead>
                      {can?.revoke_collaborator && (
                        <TableHead scope="col" className="px-4">
                          <span className="sr-only">Revoke</span>
                        </TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.collaborators.map((c) => (
                      <TableRow key={c.user} className="hover:bg-transparent">
                        <TableCell className="px-4 py-2.5">
                          <span className="font-semibold">{nameOf(c.user)}</span> <span className="text-muted-foreground">{c.user}</span>
                        </TableCell>
                        <TableCell className="px-4 py-2.5">{c.expires === null ? '—' : formatWhen(c.expires)}</TableCell>
                        <TableCell className="px-4 py-2.5">
                          <Countdown until={c.expires} demoClock />
                        </TableCell>
                        <TableCell className="px-4 py-2.5">
                          {c.renewals_used ?? '—'} of {RENEWAL_LIMIT}
                        </TableCell>
                        <TableCell className="px-4 py-2.5">
                          <GrantChip collaborator={c} />
                        </TableCell>
                        {can?.revoke_collaborator && (
                          <TableCell className="px-4 py-2.5 text-right">
                            {c.expires !== null && (
                              <Button variant="outline" size="lg" disabled={busy} onClick={() => revoke(c.user)}>
                                <UserMinusIcon data-icon="inline-start" />
                                Revoke
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {pendingInvitations.length > 0 && (
              <ul aria-label="Invitations waiting for an approver" className="flex flex-col rounded-md border border-border bg-surface">
                {pendingInvitations.map((r) => (
                  <PendingInvitation key={r.id} request={r} />
                ))}
              </ul>
            )}
            <CleanupLine />
          </section>

          {pendingRenewals.length > 0 && (
            <section aria-labelledby="renewals-title" className="flex flex-col gap-3">
              <Heading id="renewals-title" title="Pending renewals" count={pendingRenewals.length} />
              <ErrorBanner error={approvals.error} />
              {pendingRenewals.map((r) => (
                <RequestSummary key={r.id} request={r}>
                  {canDecide(r.id) ? (
                    <RequestDecisionForm busy={busy} onDecide={(verdict, comment) => decide(r.id, verdict, comment)} />
                  ) : (
                    <p className="text-muted-foreground">{approvals.data ? 'Waiting for an approver.' : 'Checking whether you may approve it…'}</p>
                  )}
                </RequestSummary>
              ))}
            </section>
          )}

          <section aria-labelledby="documents-title" className="flex flex-col gap-3">
            <Heading id="documents-title" title="Documents" />
            <DocumentList documents={data.documents} />
          </section>
        </>
      )}
    </div>
  );
}
