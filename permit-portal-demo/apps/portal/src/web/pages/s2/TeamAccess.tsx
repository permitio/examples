import { RefreshCwIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { getPersona } from '@/api';
import { SectionHeading } from '@/signs/plates';
import { ErrorBanner, Notice } from '@/components/ErrorBanner';
import { EmptyNote, Lede } from '@/components/parts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CHANGE_CONFIRMED, useAction, useResource } from '@/hooks';
import { PagePlate } from '../s4/parts';
import { grantRole, revokeRole } from './grants';
import { grantKey, NO_TOGGLES, roleLabel, type ToggleState, toggleStateFor, type TreeNode, treeOf, withConfirmed } from './team';
import type { AssignmentsResponse, TeamResponse } from './types';

/** One resource of the tree: its name and key, a toggle for each role Permit lets the persona give there, and what sits under it. */
function Branch({ node, held, busy, onToggle }: {
  node: TreeNode;
  held: ReadonlySet<string>;
  busy: boolean;
  onToggle: (role: string, resource: string, on: boolean) => void;
}) {
  return (
    <li>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-3">
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold">{node.name}</span>
          <code className="font-mono text-sm text-muted-foreground">{node.resource}</code>
        </span>
        <span className="flex flex-wrap gap-x-5 gap-y-2">
          {node.roles.map((role) => (
            <label key={role} className="flex cursor-pointer items-center gap-2 font-semibold">
              <Switch
                aria-label={`${roleLabel(role)} on ${node.name}`}
                checked={held.has(grantKey(role, node.resource))}
                disabled={busy}
                onCheckedChange={(on) => onToggle(role, node.resource, on)}
              />
              {roleLabel(role)}
            </label>
          ))}
        </span>
      </div>
      {node.children.length > 0 && (
        <ul className="ml-6 flex flex-col border-l border-border">
          {node.children.map((child) => (
            <Branch key={child.resource} node={child} held={held} busy={busy} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * S2's Team access, for Sam and Frodo: pick a member, then give or take away roles on EANs, child
 * accounts and locations. The tree holds only what Permit lets the persona grant (GET /api/s2/team is built from one bulk
 * check), so Frodo sees EAN-1001 and what sits under it and nothing else, and the toggles that are on are the member's
 * roles within that same scope (the assignments read is checked the same way). Each toggle asks the portal to check
 * `grant_<role>` on that exact resource first, and the notice comes once the PDP holds the change. The page reads when it
 * opens, when a person is picked, on Refresh and when its tab is shown again, but not on a timer, and not after a change:
 * once the PDP confirms one, the toggle flips from what is on screen (see team.ts), since reading the assignments again
 * would repeat the `grant_` check on every one of them in the decision panel and bury the check and the write of the change.
 */
export function TeamAccess() {
  const me = getPersona();
  const team = useResource<TeamResponse>('/api/s2/team');
  const [choice, setChoice] = useState<string>();
  const action = useAction();
  const [notice, setNotice] = useState<string>();
  const [toggles, setToggles] = useState<ToggleState>(NO_TOGGLES);

  // People to give roles to: the organization's members except the persona who is signed in.
  const people = (team.data?.members ?? []).filter((m) => m.key !== me);
  const member = people.find((m) => m.key === choice);
  const assignments = useResource<AssignmentsResponse>(member === undefined ? null : `/api/s2/members/${encodeURIComponent(member.key)}/assignments`);

  // The toggles are the page's own copy of the member's assignments: taken afresh from each read, and kept in step with the
  // changes the PDP confirms in between. Setting state while rendering is React's way to reset it when what it came from changes.
  const shown = toggleStateFor(toggles, assignments.data);
  if (shown !== toggles) setToggles(shown);

  const choose = (key: string) => {
    setChoice(key);
    setNotice(undefined);
    action.clearError();
  };

  const toggle = async (role: string, resource: string, on: boolean) => {
    if (member === undefined) return;
    const grant = { user: member.key, role, resource };
    // The notice changes once, when the answer arrives: cleared up front, the page would jump twice.
    const done = await action.run(() => (on ? grantRole(grant) : revokeRole(grant)));
    setNotice(done !== undefined ? CHANGE_CONFIRMED : undefined);
    // A confirmed change, a repeat of one Permit already had included, shows on its toggle without a second read. A refusal or
    // any other failure leaves the toggle where it was, and its words are in the banner.
    if (done !== undefined) setToggles((t) => withConfirmed(t, role, resource, on));
  };

  const refresh = () => {
    team.reload();
    assignments.reload();
  };

  const tree = treeOf(team.data?.grantable ?? []);
  const aside = team.data && people.length > 0 ? { icon: UsersIcon, text: `${people.length} ${people.length === 1 ? 'person' : 'people'}` } : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PagePlate title="Team access" aside={aside} />
      <Lede>Roles for the people in your organization, on its EANs, child accounts and locations. Permit decides which ones you may grant.</Lede>
      <ErrorBanner error={team.error} />
      {team.data === undefined ? (
        team.error === undefined && <p className="text-muted-foreground">Loading your team…</p>
      ) : people.length === 0 ? (
        <EmptyNote>There is no one else in your organization yet.</EmptyNote>
      ) : team.data.grantable.length === 0 ? (
        <EmptyNote>Permit does not let you give any role in your organization.</EmptyNote>
      ) : (
        <>
          <section aria-labelledby="team-people-title" className="flex flex-col gap-3">
            <SectionHeading id="team-people-title" title="Choose a person" />
            <ToggleGroup
              aria-labelledby="team-people-title"
              variant="outline"
              spacing={0}
              className="flex-wrap"
              disabled={action.busy}
              value={member === undefined ? [] : [member.key]}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) choose(next);
              }}
            >
              {people.map((p) => (
                <ToggleGroupItem
                  key={p.key}
                  value={p.key}
                  size="lg"
                  className="px-3 aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground aria-pressed:hover:text-background"
                >
                  {p.name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </section>

          {member === undefined ? (
            <p className="text-muted-foreground">Choose a person to see and change their access.</p>
          ) : (
            <section aria-labelledby="team-access-title" className="flex flex-col gap-3">
              <SectionHeading
                id="team-access-title"
                title={`Access for ${member.name}`}
                action={
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {/* Beside Refresh rather than above the tree, so the tree does not move while a change is waiting for the PDP. */}
                    {action.busy && (
                      <span role="status" className="text-muted-foreground">
                        Asking Permit, then waiting for the PDP…
                      </span>
                    )}
                    {/* The page re-reads when its tab is shown again; with the console in a window beside it, this asks again. */}
                    <Button variant="outline" size="lg" disabled={action.busy} onClick={refresh}>
                      <RefreshCwIcon data-icon="inline-start" />
                      Refresh
                    </Button>
                  </span>
                }
              />
              {/* The outcome of a change, in place above the tree: a refusal in Permit's words, or the PDP's confirmation. */}
              <ErrorBanner error={action.error} onDismiss={action.clearError} />
              <Notice text={notice} onDismiss={() => setNotice(undefined)} />
              <ErrorBanner error={assignments.error} />
              {assignments.data === undefined ? (
                assignments.error === undefined && <p className="text-muted-foreground">Loading {member.name}'s access…</p>
              ) : (
                <ul aria-label={`Roles for ${member.name}`} className="flex flex-col rounded-md border border-border bg-surface [&>li:last-child>div:first-child]:border-b-0">
                  {tree.map((node) => (
                    <Branch key={node.resource} node={node} held={shown.held} busy={action.busy} onToggle={toggle} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
