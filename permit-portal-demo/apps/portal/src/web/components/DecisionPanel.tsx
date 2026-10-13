import {
  ChevronRightIcon,
  DatabaseZapIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { api, emptyFeed, explainEvent, type FeedState, isShown, mergeFeed } from '@/api';
import { formatClock, formatPrecise, replayNote, ruleLegend, timeLegend } from '@/format';
import { usePersonaName, useVisible } from '@/hooks';
import type { CheckEvent, EventsResponse, ExplainResponse, ReadEvent, WriteEvent } from '@/types';
import { Decision } from '@/components/CheckChips';
import { ErrorBanner } from '@/components/ErrorBanner';
import { SignDirectory } from '@/components/panel/SignDirectory';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

const POLL_MS = 700;

/** A block of the PDP's own words: JSON on Permit's code tint, scrolling past 20rem. */
const CODE =
  'max-h-80 overflow-auto rounded-sm bg-muted px-3 py-2.5 font-mono text-[0.78rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]';

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '—';
}

/** A labelled part of an opened check. */
function DetailPart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-xs font-bold text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

type Explanation =
  | { state: 'loading' }
  | { state: 'done'; result: ExplainResponse }
  | { state: 'failed'; error: unknown };

/**
 * Permit's reason for one recorded check, asked for when the row is opened: the portal replays the
 * check's input on the PDP now (POST /api/events/:id/explain). When the replay decides differently,
 * the data changed since.
 */
function PdpReason({ event }: { event: CheckEvent }) {
  const [explanation, setExplanation] = useState<Explanation>({ state: 'loading' });

  useEffect(() => {
    let alive = true;
    explainEvent(event.id).then(
      (result) => {
        if (alive) setExplanation({ state: 'done', result });
      },
      (error: unknown) => {
        if (alive) setExplanation({ state: 'failed', error });
      },
    );
    return () => {
      alive = false;
    };
  }, [event.id]);

  if (explanation.state === 'loading')
    return <p className="text-sm text-muted-foreground">loading…</p>;
  if (explanation.state === 'failed') return <ErrorBanner error={explanation.error} />;
  const { reason, allow } = explanation.result;
  const note = typeof allow === 'boolean' ? replayNote(event.allow, allow) : undefined;
  const legend = ruleLegend(reason);
  // The check's time and any grant expiry, from the input and from the request as the PDP evaluated
  // it.
  const times = timeLegend([event.input, reason]);
  // The reason is the replay's, so it is framed in red when the replay denies.
  const denied = (typeof allow === 'boolean' ? allow : event.allow) === false;
  return (
    <>
      {note && (
        <p
          className="rounded-sm border border-permit-ink bg-card px-3 py-2 text-sm font-bold"
          role="note"
        >
          {note}
        </p>
      )}
      {reason === null || reason === undefined ? (
        <p className="text-sm text-muted-foreground">The PDP returned no reason for this check.</p>
      ) : (
        <pre className={cn(CODE, denied && 'border border-deny bg-background')}>
          {pretty(reason)}
        </pre>
      )}
      {legend.length > 0 && (
        <dl
          className="flex flex-col gap-0.5 font-mono text-[0.8rem]"
          aria-label="Rule names in the reason"
        >
          {legend.map((rule) => (
            <div key={rule.encoded} className="flex flex-wrap gap-x-1.5">
              <dt>{rule.encoded}</dt>
              <dd className="text-muted-foreground">
                = {rule.readable} <span className="font-permit">({rule.kind})</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {times.length > 0 && (
        <DetailPart title="Times in this check, as clock times">
          <dl
            className="flex flex-col gap-0.5 text-[0.8rem]"
            aria-label="Times in this check, as clock times"
          >
            {times.map((t) => (
              <div key={t.label} className="flex flex-wrap gap-x-2">
                <dt className="font-mono">{t.label}</dt>
                <dd>{formatPrecise(t.ms)}</dd>
              </div>
            ))}
          </dl>
        </DetailPart>
      )}
    </>
  );
}

/** The number a log entry carries, so the presenter can point from a sign to its entry. */
function NumberTag({ id }: { id: number }) {
  return (
    <span className="grid h-6 min-w-8 place-items-center rounded-sm border border-permit-ink px-1 text-xs font-bold text-permit-ink">
      #{id}
    </span>
  );
}

/**
 * One entry of the log that opens: its number, a summary beside what it came to (`outcome`), and,
 * opened, `children`. Opening it holds newer rows back, so the presenter can read it while the feed
 * goes on.
 */
function OpeningRow({
  id,
  expanded,
  onToggle,
  summary,
  outcome,
  children,
}: {
  id: number;
  expanded: boolean;
  onToggle: () => void;
  summary: ReactNode;
  outcome: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 rounded-md border border-border py-1.5 pl-3">
      <span className="pt-2">
        <NumberTag id={id} />
      </span>
      <Collapsible
        open={expanded}
        onOpenChange={(next) => {
          if (next !== expanded) onToggle();
        }}
        className="min-w-0 flex-1"
      >
        <CollapsibleTrigger className="grid w-full cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-accent">
          <ChevronRightIcon
            aria-hidden
            className={
              expanded ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'
            }
          />
          <span className="flex min-w-0 flex-col">{summary}</span>
          {outcome}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-3 pt-1 pb-3">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * One check: action, resource, who, where and when, and Permit's answer; opened, the input and the
 * PDP's reason.
 */
function CheckRow({
  event,
  who,
  expanded,
  onToggle,
}: {
  event: CheckEvent;
  who: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const guard = event.source === 'guard';
  return (
    <OpeningRow
      id={event.id}
      expanded={expanded}
      onToggle={onToggle}
      outcome={<Decision allow={event.allow} />}
      summary={
        <>
          <span className="font-mono text-[0.85rem] [overflow-wrap:anywhere]">
            {event.action} <span className="text-muted-foreground">{event.resource}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {who} in <span className="font-mono">{event.tenant}</span>, {formatClock(event.at)}
          </span>
          {(guard || event.label !== undefined) && (
            <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {guard && <span>guard check by the portal</span>}
              {event.label !== undefined && <span>{event.label}</span>}
            </span>
          )}
        </>
      }
    >
      <p className="text-sm">
        Can {who} <code className="font-mono">{event.action}</code>{' '}
        <code className="font-mono">{event.resource}</code> in{' '}
        <code className="font-mono">{event.tenant}</code>?
      </p>
      <DetailPart title="Input sent to the PDP">
        <pre className={CODE}>{pretty(event.input)}</pre>
      </DetailPart>
      {event.error !== undefined ? (
        <DetailPart title="The check failed">
          <p className="text-sm font-bold text-deny">{event.error}</p>
        </DetailPart>
      ) : (
        <DetailPart title="Permit PDP reason (verbatim)">
          <PdpReason event={event} />
        </DetailPart>
      )}
    </OpeningRow>
  );
}

/**
 * One read: the PDP was asked for a list of what `who` may do (user permissions), not for a yes or
 * no. So the row has no decision, only how many entries came back; opened, the request as it was
 * sent.
 */
function ReadRow({
  event,
  who,
  expanded,
  onToggle,
}: {
  event: ReadEvent;
  who: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tenants = event.tenants.join(', ');
  const entries = event.entries ?? 0;
  return (
    <OpeningRow
      id={event.id}
      expanded={expanded}
      onToggle={onToggle}
      outcome={
        event.error !== undefined ? (
          <span className="text-xs font-bold text-deny">no answer</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {entries === 1 ? '1 entry' : `${entries} entries`}
          </span>
        )
      }
      summary={
        <>
          <span className="font-mono text-[0.85rem] [overflow-wrap:anywhere]">
            user permissions
          </span>
          <span className="text-xs text-muted-foreground">
            {who} in <span className="font-mono">{tenants}</span>, {formatClock(event.at)}
          </span>
          <span className="text-xs text-muted-foreground">a list from the PDP, not a decision</span>
        </>
      }
    >
      <p className="text-sm">
        What may {who} do in <code className="font-mono">{tenants}</code>?
      </p>
      <DetailPart title="Request sent to the PDP (POST /user-permissions)">
        <pre className={CODE}>{pretty(event.request)}</pre>
      </DetailPart>
      {event.error !== undefined ? (
        <DetailPart title="The read failed">
          <p className="text-sm font-bold text-deny">{event.error}</p>
        </DetailPart>
      ) : (
        <DetailPart title="Permit's answer">
          <p className="text-sm">
            {entries === 1 ? '1 entry' : `${entries} entries`}, one for each resource {who} may act
            on, with the roles held there and the actions they allow. A list, not a yes or no: there
            is no decision to explain.
          </p>
        </DetailPart>
      )}
    </OpeningRow>
  );
}

/** One change the portal wrote to Permit, and whether the local PDP confirmed it. */
function WriteRow({ event }: { event: WriteEvent }) {
  return (
    <li
      className={cn(
        'flex gap-3 rounded-md border bg-card px-3 py-2.5',
        event.ok ? 'border-permit-ink' : 'border-deny',
      )}
    >
      <NumberTag id={event.id} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-start gap-1.5 text-sm font-bold">
          <DatabaseZapIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-permit-ink" />
          <span>
            <span className="sr-only">Change: </span>
            {event.what}
          </span>
        </span>
        {event.ok ? (
          <span className="text-sm">Change confirmed by the PDP</span>
        ) : (
          <span className="text-sm font-bold text-deny">
            {event.error ?? 'The change was not confirmed.'}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{formatClock(event.at)}</span>
      </div>
    </li>
  );
}

interface PanelView {
  /** The check rows the presenter has opened. */
  expanded: ReadonlySet<number>;
  /**
   * While any row is open, rows newer than this id wait behind "Show newest", so the open row stays
   * put.
   */
  pausedAt: number | null;
}

const LIVE: PanelView = { expanded: new Set(), pausedAt: null };

interface DecisionPanelProps {
  /** The current persona's key, whose checks make the directory signs. */
  persona: string;
  /** The current persona's display name; the signs use the first name. */
  personaName: string;
  open: boolean;
  onToggle: () => void;
}

/**
 * Every check and change the portal makes, newest first, polled from GET /api/events, under
 * directory signs for where the current persona may go. Polling pauses while the tab is hidden, and
 * the poll itself goes out as a background refresh. Checks caused by pages re-reading themselves
 * stay out of the log unless "Show page refreshes" is on; the signs count them. "Clear view" hides
 * rows and signs here only; the portal keeps its log. While the presenter has a row open, newer
 * rows are held back (and the open row is never dropped from the feed) until they ask for the
 * newest. Hidden, the panel is a purple rail and keeps polling.
 */
export function DecisionPanel({ persona, personaName, open, onToggle }: DecisionPanelProps) {
  const visible = useVisible();
  const nameOf = usePersonaName();
  const [feed, setFeed] = useState<FeedState>(emptyFeed);
  const feedRef = useRef(feed);
  const [hiddenThrough, setHiddenThrough] = useState(0);
  const [showRefreshes, setShowRefreshes] = useState(false);
  const [view, setView] = useState<PanelView>(LIVE);
  const keepRef = useRef(view.expanded);
  const panelRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    keepRef.current = view.expanded;
  }, [view.expanded]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await api.get<EventsResponse>(`/api/events?since=${feedRef.current.lastId}`, {
          source: 'refresh',
        });
        if (!alive) return;
        const next = mergeFeed(feedRef.current, res, keepRef.current);
        if (next.lastId < feedRef.current.lastId) {
          // The portal restarted and its ids began again, so earlier positions mean nothing now.
          setHiddenThrough(0);
          setView(LIVE);
        }
        feedRef.current = next;
        setFeed(next);
        setError(undefined);
      } catch (e) {
        if (alive) setError(e);
      }
      if (alive) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [visible]);

  const { expanded, pausedAt } = view;
  const unhidden = feed.events.filter((e) => e.id > hiddenThrough && isShown(e, showRefreshes));
  const rows =
    pausedAt === null ? unhidden : unhidden.filter((e) => e.id <= pausedAt || expanded.has(e.id));
  const held =
    pausedAt === null ? 0 : unhidden.filter((e) => e.id > pausedAt && !expanded.has(e.id)).length;
  const newestShown = rows[0]?.id ?? 0;

  const toggle = (id: number) =>
    setView((v) => {
      const next = new Set(v.expanded);
      if (!next.delete(id)) next.add(id);
      return { expanded: next, pausedAt: next.size === 0 ? null : (v.pausedAt ?? newestShown) };
    });

  const showNewest = () => {
    setView(LIVE);
    panelRef.current?.scrollTo({ top: 0 });
  };

  const clearView = () => {
    setHiddenThrough(feed.lastId);
    setView(LIVE);
  };

  if (!open) {
    return (
      <aside
        aria-label="Permit decisions"
        className="permit permit-band flex shrink-0 justify-end p-2 lg:flex-col lg:justify-start"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Show decisions"
          title="Show decisions"
          onClick={onToggle}
        >
          <PanelRightOpenIcon />
        </Button>
      </aside>
    );
  }

  const firstName = personaName.split(' ')[0] ?? personaName;
  return (
    <>
      <Separator orientation="vertical" className="hidden bg-permit lg:block" />
      <aside
        ref={panelRef}
        aria-label="Permit decisions"
        className="permit flex min-w-0 flex-col bg-background lg:w-[31rem] lg:shrink-0 lg:overflow-y-auto"
      >
        <div className="sticky top-0 z-10 flex flex-col bg-background">
          <div className="permit-band flex items-center justify-between gap-3 px-5 py-3">
            <h2 className="text-lg font-extrabold">Permit decisions</h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Hide decisions"
              title="Hide decisions"
              onClick={onToggle}
            >
              <PanelRightCloseIcon />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-5 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <Switch
                checked={showRefreshes}
                onCheckedChange={(checked) => setShowRefreshes(checked)}
              />
              Show page refreshes
            </label>
            <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={clearView}>
              Clear view
            </Button>
          </div>
          {pausedAt !== null && (
            <div
              className="flex items-center gap-3 border-b border-border bg-card px-5 py-2.5"
              role="status"
            >
              <span className="min-w-0 flex-1 text-sm font-bold">
                {held === 0
                  ? 'New decisions wait while a row is open.'
                  : `${held} newer ${held === 1 ? 'decision waits' : 'decisions wait'} while a row is open.`}
              </span>
              <Button variant="outline" size="sm" onClick={showNewest}>
                Show newest
              </Button>
            </div>
          )}
        </div>
        {error !== undefined && (
          <div className="flex flex-col gap-2 px-5 pt-4">
            <p className="text-sm font-bold text-deny">The decision feed is not updating.</p>
            <ErrorBanner error={error} />
          </div>
        )}
        <SignDirectory
          events={feed.events}
          persona={persona}
          firstName={firstName}
          after={hiddenThrough}
        />
        <section aria-labelledby="panel-log-title" className="flex flex-col gap-3 px-5 pt-6 pb-5">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="panel-log-title" className="text-lg font-extrabold">
              Checks and changes
            </h3>
            <span className="text-sm text-muted-foreground">Newest first</span>
          </div>
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
              Each check and change the portal makes appears here, newest first.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {rows.map((event) =>
                event.kind === 'check' ? (
                  <CheckRow
                    key={event.id}
                    event={event}
                    who={nameOf(event.user)}
                    expanded={expanded.has(event.id)}
                    onToggle={() => toggle(event.id)}
                  />
                ) : event.kind === 'read' ? (
                  <ReadRow
                    key={event.id}
                    event={event}
                    who={nameOf(event.user)}
                    expanded={expanded.has(event.id)}
                    onToggle={() => toggle(event.id)}
                  />
                ) : (
                  <WriteRow key={event.id} event={event} />
                ),
              )}
            </ol>
          )}
        </section>
      </aside>
    </>
  );
}
