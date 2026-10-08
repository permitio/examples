// The portal's notices: a finished action, or a failed request in the server's own words. Both are
// framed, neutral panels: a refusal is information, never an alarm, and
// red stays in the Permit panel.

import { BanIcon, CheckIcon, InfoIcon, XIcon } from 'lucide-react';
import { ApiError } from '../api';
import { Button } from './ui/button';

function readError(error: unknown): { text: string; status?: number; deny: boolean } {
  if (error instanceof ApiError) return { text: error.message, status: error.status, deny: error.decision === 'deny' };
  // fetch rejects with a TypeError when the request never got an answer.
  if (error instanceof TypeError) return { text: `The portal API did not answer (${error.message}). Check that the portal is running.`, deny: false };
  if (error instanceof Error) return { text: error.message, deny: false };
  return { text: String(error), deny: false };
}

function Dismiss({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
      <XIcon />
    </Button>
  );
}

/** Confirms a finished action, for example that the local PDP holds a change. */
export function Notice({ text, onDismiss }: { text: string | undefined; onDismiss?: () => void }) {
  if (!text) return null;
  return (
    <div className="flex items-start gap-3 rounded-md border border-foreground bg-surface py-3 pr-2 pl-4" role="status">
      <CheckIcon aria-hidden className="mt-0.5 size-5 shrink-0" />
      <p className="min-w-0 flex-1">{text}</p>
      {onDismiss && <Dismiss onDismiss={onDismiss} />}
    </div>
  );
}

/** A failed request, in the server's own words. A policy deny says so; its red DENY plate is in the Permit panel. */
export function ErrorBanner({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (error === undefined || error === null) return null;
  const { text, status, deny } = readError(error);
  const Icon = deny ? BanIcon : InfoIcon;
  return (
    <div className="flex items-start gap-3 rounded-md border border-foreground bg-surface py-3 pr-2 pl-4" role="alert">
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0" />
      <p className="min-w-0 flex-1">
        {deny && <span className="font-bold">Permit denied this. </span>}
        {text}
      </p>
      {status !== undefined && <span className="self-center font-mono text-sm text-muted-foreground">HTTP {status}</span>}
      {onDismiss && <Dismiss onDismiss={onDismiss} />}
    </div>
  );
}
