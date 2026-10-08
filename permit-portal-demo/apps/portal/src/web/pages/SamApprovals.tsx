import { ClipboardCheckIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { ErrorBanner, Notice } from '../components/ErrorBanner';
import { EmptyNote, Heading, Lede } from '../components/parts';
import { RequestDecisionForm, RequestSummary } from '../components/RequestSummary';
import { Button } from '../components/ui/button';
import { grantDurations } from '../format';
import { decideAndConfirm, useAction, useMeta, useResource } from '../hooks';
import type { ApprovalsResponse } from '../types';
import { PagePlate } from './s4/parts';

/** Requests waiting for this persona's decision. GET /api/approvals lists only those Permit lets them decide. */
export function SamApprovals() {
  const approvals = useResource<ApprovalsResponse>('/api/approvals');
  const action = useAction();
  const meta = useMeta();
  const [notice, setNotice] = useState<string>();

  const decide = async (id: string, verdict: 'approve' | 'deny', comment: string, durationMs?: number) => {
    await decideAndConfirm(action.run, setNotice, id, verdict, comment, 'Approved', durationMs);
    approvals.reload();
  };

  const requests = approvals.data?.requests;
  const waiting = requests && { icon: ClipboardCheckIcon, text: requests.length === 0 ? 'None waiting' : `${requests.length} waiting` };
  return (
    <div className="flex flex-col gap-6">
      <PagePlate title="Approvals" aside={waiting} />
      <Lede>Requests waiting for your decision. Permit decides which ones you may approve.</Lede>
      <section aria-labelledby="queue-title" className="flex flex-col gap-3">
        <Heading
          id="queue-title"
          title="Waiting for your approval"
          count={requests?.length}
          action={
            <Button variant="outline" size="lg" onClick={approvals.reload}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          }
        />
        <ErrorBanner error={action.error} onDismiss={action.clearError} />
        <Notice text={notice} onDismiss={() => setNotice(undefined)} />
        <ErrorBanner error={approvals.error} />
        {requests === undefined ? (
          approvals.error === undefined && <p className="text-muted-foreground">Loading approvals…</p>
        ) : requests.length === 0 ? (
          <EmptyNote>Nothing is waiting for your approval.</EmptyNote>
        ) : (
          requests.map((r) => (
            <RequestSummary key={r.id} request={r}>
              <RequestDecisionForm
                busy={action.busy}
                durations={r.type === 'collaborator_invite' ? grantDurations(meta.grantDemoDurationMs) : undefined}
                onDecide={(verdict, comment, durationMs) => decide(r.id, verdict, comment, durationMs)}
              />
            </RequestSummary>
          ))
        )}
      </section>
    </div>
  );
}
