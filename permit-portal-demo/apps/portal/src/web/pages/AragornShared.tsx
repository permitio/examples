import { ArrowRightIcon, BanIcon, HourglassIcon, ListChecksIcon, LockKeyholeIcon, RefreshCwIcon, TimerOffIcon, Undo2Icon, UploadIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { GateSign, HiddenDetails } from '@/signs/plates';
import { api, getPersona } from '../api';
import { CheckChips } from '../components/CheckChips';
import { ErrorBanner, Notice } from '../components/ErrorBanner';
import { EmptyNote, Heading, Lede } from '../components/parts';
import { RequestSummary } from '../components/RequestSummary';
import { Button } from '../components/ui/button';
import { Field, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { formatCountdown, formatWhen } from '../format';
import { PAGE_REFRESH_MS, useAction, useMeta, useNow, useResource } from '../hooks';
import type { BulkCheckRequest, BulkCheckResponse, Collaborator, DemoRequest, Doc, RequestStatus, ShipmentDetail, ShipmentsResponse } from '../types';
import { accessState } from './s4/access';
import { CargoFacts, Fact, ShipmentSign } from './s4/parts';
import { DocumentList } from './ShipmentDetail';

/** The live checks re-run faster than the page: they are what the presenter watches change at the expiry. */
const LIVE_CHECKS_MS = 5_000;
/** The quarter-second tick Countdown and GrantChip use, so the gate turns when they do. */
const GATE_TICK_MS = 250;
const TENANT = 'shire-freight';
/** The shipment S4 shares with the broker. */
const SHARED_SHIPMENT = 'SHP-77001';
const RENEWAL_LIMIT = 2;
// 45 days is offered on purpose: renewal_within_limit allows at most 30, so Permit denies it.
const RENEWAL_DAYS = [7, 45];
const RENEWAL_ITEMS = RENEWAL_DAYS.map((d) => ({ value: String(d), label: `${d} days` }));

/** The gate plate for each state of Aragorn's access; only an open gate is green. */
const PLATES = {
  open: { tone: 'go', icon: ArrowRightIcon, label: 'Open' },
  pending: { tone: 'graphite', icon: HourglassIcon, label: 'Pending' },
  ended: { tone: 'graphite', icon: TimerOffIcon, label: 'Ended' },
} as const;
/** An ended gate's pictogram when it did not simply run out: undo for revoked access, no entry for a refused invitation. */
const ENDED_ICON: Partial<Record<RequestStatus, typeof TimerOffIcon>> = { revoked: Undo2Icon, denied: BanIcon, canceled: BanIcon };

// A module constant, so every timed run posts the same body.
const LIVE_CHECKS: BulkCheckRequest = {
  checks: [
    { action: 'view', resource: { type: 'shipment', key: 'SHP-77001', tenant: TENANT } },
    { action: 'view', resource: { type: 'shipment', key: 'SHP-77002', tenant: TENANT } },
    { action: 'view_profile', resource: { type: 'organization', key: TENANT, tenant: TENANT } },
  ],
};

function LiveChecks() {
  // The first run and "Run checks" show in the decision panel; the timed re-runs go out as page refreshes.
  const run = useResource<BulkCheckResponse>('/api/checks/bulk', { refreshMs: LIVE_CHECKS_MS, body: LIVE_CHECKS });
  // After a failed run the chips show no result rather than the previous one: they claim what Permit says now.
  const latest = run.error === undefined ? run.data : undefined;
  return (
    <section aria-labelledby="live-checks-title" className="flex flex-col gap-3">
      <Heading
        id="live-checks-title"
        title="Live checks"
        action={
          <Button size="lg" onClick={run.reload}>
            <ListChecksIcon data-icon="inline-start" />
            Run checks
          </Button>
        }
      />
      <p className="text-muted-foreground">One bulk check to Permit, run again every 5 seconds while this page is open.</p>
      <CheckChips
        label="Live Permit checks"
        checks={LIVE_CHECKS.checks.map((c, i) => ({ label: `${c.action} ${c.resource.type}:${c.resource.key}`, allow: latest?.results[i]?.allow }))}
      />
      <ErrorBanner error={run.error} />
    </section>
  );
}

/** The persona's most recent invitation on the shared shipment, if any. */
function latestInvite(requests: DemoRequest[], me: string): DemoRequest | undefined {
  return requests
    .filter((r) => r.type === 'collaborator_invite' && r.requested_for === me)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

/** Why there is no access to show, from the invitation's state in Great Eagle's workflow. */
function noAccessText(invite: DemoRequest | undefined): string {
  switch (invite?.status) {
    case 'pending':
      return `You have no access to ${SHARED_SHIPMENT} yet. It starts once an approver approves the invitation.`;
    case 'revoked':
      return `Your access to ${SHARED_SHIPMENT} was revoked.`;
    case 'denied':
      return `The invitation was denied, so you have no access to ${SHARED_SHIPMENT}.`;
    case 'approved':
    case 'expired':
      return `Your access to ${SHARED_SHIPMENT} has ended.`;
    case 'canceled':
      return `The invitation was canceled, so you have no access to ${SHARED_SHIPMENT}.`;
    default:
      return `Nothing on ${SHARED_SHIPMENT} has been shared with you.`;
  }
}

/**
 * Aragorn's gate on the shared shipment: green "Open" with the time left while Aragorn's grant is
 * live, graphite "Pending" while the invitation waits, graphite "Ended" once it expired, was revoked or was denied, and
 * nothing when nothing was shared. While Aragorn holds a grant entry, its facts and `children` show beneath.
 */
function AccessGate({ grant, invite, children }: { grant: Collaborator | undefined; invite: DemoRequest | undefined; children: ReactNode }) {
  const meta = useMeta();
  const now = useNow(GATE_TICK_MS);
  // Grant expiries are written on the portal's demo clock, so the gate reads them against it, as Countdown does.
  const demoNow = now + meta.demoClock.offsetMs;
  const state = accessState(grant, invite, demoNow);
  if (state === 'none') return null;
  const plate = PLATES[state];
  const icon = state === 'ended' ? ((invite && ENDED_ICON[invite.status]) ?? plate.icon) : plate.icon;
  const clock =
    state === 'open' && grant !== undefined && grant.expires !== null ? { value: formatCountdown(grant.expires - demoNow), caption: 'left' } : undefined;
  return (
    <GateSign tone={plate.tone} icon={icon} label={plate.label} title={`Your access to ${SHARED_SHIPMENT}`} clock={clock}>
      {grant && (
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label="Access ends">{grant.expires === null ? '—' : formatWhen(grant.expires)}</Fact>
            <Fact label="Renewals used">
              {grant.renewals_used ?? '—'} of {RENEWAL_LIMIT}
            </Fact>
          </dl>
          {children}
        </div>
      )}
    </GateSign>
  );
}

/**
 * The external broker's view: Aragorn's time-boxed access to SHP-77001 as a gate sign with its clock, a live
 * bulk check, the shipment itself while Permit allows Aragorn to view it, and what was shared with Aragorn.
 */
export function AragornShared() {
  const me = getPersona();
  const shipments = useResource<ShipmentsResponse>('/api/s4/shipments', { refreshMs: PAGE_REFRESH_MS });
  const detailPath = `/api/s4/shipments/${SHARED_SHIPMENT}`;
  const detail = useResource<ShipmentDetail>(detailPath, { refreshMs: PAGE_REFRESH_MS });
  const action = useAction();
  const [notice, setNotice] = useState<string>();
  const [days, setDays] = useState(RENEWAL_DAYS[0] ?? 7);
  const [docName, setDocName] = useState('customs-declaration.pdf');

  const shared = shipments.data?.shared;
  const grant = detail.data?.collaborators.find((c) => c.user === me);
  const invite = detail.data && latestInvite(detail.data.requests, me);
  const can = detail.data?.can;

  // Renewal stays on offer after the grant expires: renewable_collaborator does not look at the expiry,
  // and renewing an expired grant is the point of S4's renewal step.
  const requestRenewal = async (e: FormEvent) => {
    e.preventDefault();
    // The notice changes once, when the answer arrives: cleared up front, the page would jump twice.
    const created = await action.run(() => api.post<DemoRequest>(`${detailPath}/renewals`, { days }));
    setNotice(created ? `Renewal for ${days} days requested. It waits for an approver.` : undefined);
    shipments.reload();
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const name = docName.trim();
    const doc = await action.run(() => api.post<Doc>(`${detailPath}/documents`, { name }));
    setNotice(doc ? `Uploaded ${name}.` : undefined);
    detail.reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <ShipmentSign shipmentKey={SHARED_SHIPMENT} title={can?.view ? detail.data?.shipment.title : undefined} withDetails={can?.view === true} />
      <Lede>Shipments that other companies shared with you. You hold no role in their organizations.</Lede>
      <ErrorBanner error={action.error} onDismiss={action.clearError} />
      <Notice text={notice} onDismiss={() => setNotice(undefined)} />
      <ErrorBanner error={detail.error} />

      {detail.data && (
        <AccessGate grant={grant} invite={invite}>
          <form onSubmit={requestRenewal} className="flex flex-wrap items-end gap-3">
            <Field className="w-40">
              <FieldLabel htmlFor="renew-days">Renew for</FieldLabel>
              <Select
                items={RENEWAL_ITEMS}
                value={String(days)}
                onValueChange={(value) => {
                  if (value !== null) setDays(Number(value));
                }}
              >
                <SelectTrigger id="renew-days" className="h-9 w-full text-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RENEWAL_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value} className="text-base">
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button type="submit" variant="outline" size="lg" disabled={action.busy}>
              <RefreshCwIcon data-icon="inline-start" />
              Request renewal
            </Button>
          </form>
        </AccessGate>
      )}

      <LiveChecks />

      {can?.view && detail.data ? (
        <>
          <CargoFacts shipmentKey={SHARED_SHIPMENT} />
          <section aria-labelledby="documents-title" className="flex flex-col gap-3">
            <Heading id="documents-title" title="Documents" />
            <DocumentList documents={detail.data.documents} />
            {can.upload_docs && (
              <form onSubmit={upload} className="flex flex-wrap items-end gap-3">
                <Field className="w-full max-w-md">
                  <FieldLabel htmlFor="document-name">Document name</FieldLabel>
                  <Input
                    id="document-name"
                    value={docName}
                    required
                    autoComplete="off"
                    className="h-9 text-base md:text-base"
                    onChange={(e) => setDocName(e.target.value)}
                  />
                </Field>
                <Button type="submit" size="lg" disabled={action.busy || docName.trim() === ''}>
                  <UploadIcon data-icon="inline-start" />
                  Upload document
                </Button>
              </form>
            )}
          </section>
        </>
      ) : (
        detail.data && (
          <HiddenDetails icon={LockKeyholeIcon} title="Shipment details are hidden">
            {noAccessText(invite)}
          </HiddenDetails>
        )
      )}

      <section aria-labelledby="requests-title" className="flex flex-col gap-3">
        <Heading id="requests-title" title="Requests" />
        <ErrorBanner error={shipments.error} />
        {shared === undefined ? (
          shipments.error === undefined && <p className="text-muted-foreground">Loading…</p>
        ) : shared.length === 0 ? (
          <EmptyNote>Nothing has been shared with you yet.</EmptyNote>
        ) : (
          <ol className="flex flex-col gap-3">
            {shared.map((r) => (
              <li key={r.id}>
                <RequestSummary request={r} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
