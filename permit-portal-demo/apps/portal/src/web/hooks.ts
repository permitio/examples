// React state shared by the pages: the /api/meta payload, page visibility, a ticking clock,
// polled API reads and one-at-a-time actions.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api, decideRequest, onPortalRebuilt, portalRebuilt } from '@/api';
import type { ApproveResponse, DenyResponse, Meta } from '@/types';

/**
 * How often a page re-reads itself while it is open. Aragorn's live checks run every 5 s on their
 * own timer.
 */
export const PAGE_REFRESH_MS = 10_000;

export const MetaContext = createContext<Meta | null>(null);

export function useMeta(): Meta {
  const meta = useContext(MetaContext);
  if (!meta) throw new Error('useMeta needs a MetaContext provider');
  return meta;
}

/**
 * Maps a user key to the persona's display name; other keys (a system reviewer, say) show as they
 * are.
 */
export function usePersonaName(): (key: string) => string {
  const meta = useMeta();
  return (key) => meta.personas.find((p) => p.key === key)?.name ?? key;
}

const pageVisible = () => document.visibilityState !== 'hidden';

interface Visibility {
  visible: boolean;
  /** How many times the tab was shown again after being hidden. */
  shown: number;
}

/**
 * Whether the browser tab is visible, and a count of the times it came back. One state, so a tab
 * shown again changes both in the same render and a read keyed on them runs once.
 */
function useVisibility(): Visibility {
  const [state, setState] = useState<Visibility>(() => ({ visible: pageVisible(), shown: 0 }));
  useEffect(() => {
    const update = () =>
      setState((s) => {
        const visible = pageVisible();
        if (visible === s.visible) return s;
        return { visible, shown: visible ? s.shown + 1 : s.shown };
      });
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return state;
}

/**
 * False while the browser tab is hidden, so polling stops when the presenter switches to another
 * tab.
 */
export function useVisible(): boolean {
  return useVisibility().visible;
}

/** True once the portal was rebuilt after this tab loaded its page: the tab should be reloaded. */
export function usePortalRebuilt(): boolean {
  return useSyncExternalStore(onPortalRebuilt, portalRebuilt);
}

/** The current time, re-read every `tickMs`. */
export function useNow(tickMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return now;
}

export interface Resource<T> {
  /** The last successful response for the current path; kept while a later refresh fails. */
  data: T | undefined;
  /** The last failure, cleared by the next success. A failed read is never shown as an empty result. */
  error: unknown;
  reload: () => void;
}

interface ResourceOptions {
  /** Re-read this often while the tab is visible; each read starts after the previous one ends. */
  refreshMs?: number;
  /** POST this body instead of a GET. Must keep its identity between renders (a module constant). */
  body?: unknown;
  /** Read again whenever this value changes. */
  key?: string;
}

/**
 * Reads `path` from the portal API (nothing when it is null), optionally on a refresh timer.
 *
 * The first read for a path, a `key` or a `reload()` is the presenter's own doing, so the checks it
 * causes show in the decision panel. So is the catch-up read when the tab is shown again, timer or
 * not: the presenter switches back from the console to see what a fact change did, and the panel
 * must show that decision. Only the timer's reads go out as background refreshes, which the panel
 * hides unless asked.
 */
export function useResource<T>(
  path: string | null,
  { refreshMs, body, key }: ResourceOptions = {},
): Resource<T> {
  const { visible, shown } = useVisibility();
  const active = refreshMs === undefined || visible;
  /** The `shown` count of the last read, so a tab shown again reads again even without a timer. */
  const readAtShown = useRef(shown);
  const [state, setState] = useState<{
    path: string | null;
    data?: T | undefined;
    error?: unknown;
  }>({ path });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /**
   * The read that last finished: path, key and reload count. A read of the same one again is a
   * refresh.
   */
  const finished = useRef<string | null>(null);
  /**
   * Set while the tab is hidden, so the read that follows when it is shown again counts as the
   * presenter's.
   */
  const wasHidden = useRef(false);

  // `key`, `nonce` and `shown` are deliberate dependencies: changing any of them starts a fresh
  // read.
  useEffect(() => {
    if (!active) wasHidden.current = true;
    if (path === null || !active) return;
    const catchingUp = wasHidden.current || shown !== readAtShown.current;
    wasHidden.current = false;
    readAtShown.current = shown;
    const identity = JSON.stringify([path, key ?? null, nonce]);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (refresh: boolean) => {
      const opts = refresh ? { source: 'refresh' as const } : undefined;
      try {
        const data =
          body === undefined ? await api.get<T>(path, opts) : await api.post<T>(path, body, opts);
        if (alive) setState({ path, data });
      } catch (error) {
        if (alive)
          setState((prev) => ({ path, data: prev.path === path ? prev.data : undefined, error }));
      }
      if (!alive) return;
      finished.current = identity;
      if (refreshMs !== undefined) timer = setTimeout(() => void load(true), refreshMs);
    };
    void load(finished.current === identity && !catchingUp);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [path, active, refreshMs, body, key, nonce, shown]);

  const current = state.path === path;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    reload,
  };
}

/**
 * Runs one user action at a time and keeps its failure for an ErrorBanner. The previous error stays
 * until this action's answer replaces or clears it, so the page changes once, when the answer
 * arrives, instead of jumping twice.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = useCallback(async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await task();
      setError(undefined);
      return result;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(undefined), []);
  return { run, busy, error, clearError };
}

type Run = ReturnType<typeof useAction>['run'];

/**
 * The words a page uses after a waited change, matching the decision panel's change rows. No
 * duration on screen: it would include the portal's own round trips, and the change is visibly
 * immediate.
 */
export const CHANGE_CONFIRMED = 'Change confirmed by the PDP.';

/** Approves or denies one request through a page's `run`, then confirms the result in words. */
export async function decideAndConfirm(
  run: Run,
  setNotice: (text: string | undefined) => void,
  id: string,
  verdict: 'approve' | 'deny',
  comment: string,
  approvedWord = 'Approved',
  /** For a collaborator invitation: how long the approver says the access lasts. */
  durationMs?: number,
): Promise<ApproveResponse | DenyResponse | undefined> {
  // The notice changes once, when the answer arrives: cleared up front, the page would jump twice.
  if (verdict === 'approve') {
    const approved = await run(() => decideRequest(id, 'approve', comment, durationMs));
    setNotice(approved ? `${approvedWord}. ${CHANGE_CONFIRMED}` : undefined);
    return approved;
  }
  const denied = await run(() => decideRequest(id, 'deny', comment));
  setNotice(denied ? 'Denied. The decision is on the request record.' : undefined);
  return denied;
}
