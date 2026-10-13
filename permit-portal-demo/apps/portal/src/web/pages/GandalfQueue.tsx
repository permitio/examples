import { ClipboardCheckIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { SectionHeading, SignPlate } from '@/signs/plates';
import { Button } from '@/components/ui/button';
import { ErrorBanner, Notice } from '@/components/ErrorBanner';
import { EmptyNote, Lede } from '@/components/parts';
import { RequestDecisionForm, RequestSummary } from '@/components/RequestSummary';
import { trustFactItems } from '@/format';
import { decideAndConfirm, useAction, useResource } from '@/hooks';
import type { ReviewerQueueResponse } from '@/types';
import { FactGrid } from '@/pages/org/FactGrid';

/**
 * Great Eagle's onboarding reviewer queue: each first-admin request as a request card, with Great
 * Eagle's facts on its requester and the decision form inside it.
 */
export function GandalfQueue() {
  // Not on a timer, which would re-ask Permit every few seconds: a fact flipped in the Great Eagle
  // console reaches the card when the presenter switches back to this tab, since that read counts
  // as theirs, or on Refresh.
  const queue = useResource<ReviewerQueueResponse>('/api/s1/reviewer-queue');
  const action = useAction();
  const [notice, setNotice] = useState<string>();

  const decide = async (id: string, verdict: 'approve' | 'deny', comment: string) => {
    await decideAndConfirm(action.run, setNotice, id, verdict, comment);
    queue.reload();
  };

  const items = queue.data?.requests;
  const waiting =
    items === undefined
      ? undefined
      : {
          icon: ClipboardCheckIcon,
          text: items.length === 0 ? 'None waiting' : `${items.length} waiting`,
        };
  return (
    <div className="flex flex-col gap-6">
      <SignPlate id="queue-title" title="First-admin reviews" aside={waiting} />
      <Lede>
        Requests to become the first admin of a new organization, with the facts Great Eagle's
        systems hold on each requester.
      </Lede>
      <section aria-labelledby="queue-waiting-title" className="flex flex-col gap-3">
        <SectionHeading
          id="queue-waiting-title"
          title="Waiting for review"
          action={
            <Button variant="outline" size="lg" onClick={queue.reload}>
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          }
        />
        <ErrorBanner error={action.error} onDismiss={action.clearError} />
        <Notice text={notice} onDismiss={() => setNotice(undefined)} />
        <ErrorBanner error={queue.error} />
        {items === undefined ? (
          queue.error === undefined && <p className="text-muted-foreground">Loading the queue…</p>
        ) : items.length === 0 ? (
          <EmptyNote>No requests are waiting for review.</EmptyNote>
        ) : (
          items.map(({ request, facts, ownership_verified }) => (
            <RequestSummary key={request.id} request={request}>
              <FactGrid
                label="Great Eagle's checks for this request"
                items={trustFactItems(facts, ownership_verified)}
              />
              <RequestDecisionForm
                busy={action.busy}
                commentRequiredToDeny
                onDecide={(verdict, comment) => decide(request.id, verdict, comment)}
              />
            </RequestSummary>
          ))
        )}
      </section>
    </div>
  );
}
