import { InboxIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { SectionHeading, SignPlate } from '@/signs/plates';
import { Button } from '@/components/ui/button';
import { getPersona, hasStatus } from '@/api';
import { ErrorBanner, Notice } from '@/components/ErrorBanner';
import { EmptyNote, Lede } from '@/components/parts';
import { RequestDecisionForm, RequestSummary } from '@/components/RequestSummary';
import { decideAndConfirm, useAction, useResource } from '@/hooks';
import type { ApprovalsResponse, OrgDetail, RequestType } from '@/types';
import { OrgPage } from '@/pages/OrgPage';

/** The organization S1 builds; Éomer joins it, then takes over as its admin. */
const S1_ORG = 'riders-of-rohan';
const INBOX_TYPES: ReadonlySet<RequestType> = new Set(['member_invite', 'admin_transfer']);

/**
 * Invitations addressed to this persona, each a request card with an Accept button. Once they have accepted one, the
 * organization page follows. A single read on arrival finds out whether an earlier acceptance already made them a
 * member, because changing persona clears page state.
 */
export function EomerInbox() {
  const me = getPersona();
  const inbox = useResource<ApprovalsResponse>('/api/approvals');
  const membership = useResource<OrgDetail>(`/api/s1/organizations/${S1_ORG}`);
  const action = useAction();
  const [notice, setNotice] = useState<string>();
  const [acceptedOrg, setAcceptedOrg] = useState<string>();
  // Bumped on every acceptance so the organization view below re-reads at once, instead of showing the roles from
  // before the handover until its next refresh.
  const [accepted, setAccepted] = useState(0);

  const accept = async (id: string) => {
    const result = await decideAndConfirm(action.run, setNotice, id, 'approve', '', 'Accepted');
    if (result) {
      setAcceptedOrg(result.request.tenant);
      setAccepted((n) => n + 1);
    }
    inbox.reload();
  };

  const invitations = inbox.data?.requests.filter((r) => INBOX_TYPES.has(r.type));
  const isMember = membership.data?.members.some((m) => m.user === me) ?? false;
  const orgKey = acceptedOrg ?? (isMember ? S1_ORG : undefined);
  // A 404 only means the organization has not been created yet.
  const membershipError = hasStatus(membership.error, 404) ? undefined : membership.error;
  const waiting = invitations === undefined ? undefined : { icon: InboxIcon, text: invitations.length === 0 ? 'Nothing waiting' : `${invitations.length} waiting` };

  return (
    <div className="flex flex-col gap-6">
      <SignPlate id="inbox-sign-title" title="Inbox" aside={waiting} />
      <Lede>Invitations from your colleagues wait here for you to accept.</Lede>
      <section aria-labelledby="inbox-title" className="flex flex-col gap-3">
        <SectionHeading
          id="inbox-title"
          title="Waiting for you"
          action={
            <Button variant="outline" size="lg" onClick={inbox.reload}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          }
        />
        <ErrorBanner error={action.error} onDismiss={action.clearError} />
        <Notice text={notice} onDismiss={() => setNotice(undefined)} />
        <ErrorBanner error={inbox.error} />
        <ErrorBanner error={membershipError} />
        {invitations === undefined ? (
          inbox.error === undefined && <p className="text-muted-foreground">Loading invitations…</p>
        ) : invitations.length === 0 ? (
          <EmptyNote>No invitations are waiting for you.</EmptyNote>
        ) : (
          invitations.map((r) => (
            <RequestSummary key={r.id} request={r}>
              <RequestDecisionForm busy={action.busy} approveLabel="Accept" canDeny={false} onDecide={() => accept(r.id)} />
            </RequestSummary>
          ))
        )}
      </section>
      {orgKey && <OrgPage key={accepted} orgKey={orgKey} />}
    </div>
  );
}
