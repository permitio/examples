import { BadgeCheckIcon, LinkIcon, LogOutIcon, RefreshCwIcon, ScanSearchIcon, UserPlusIcon, UserRoundCheckIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { GateSign, SectionHeading, SignPlate, StageStrip } from '@/signs/plates';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, getPersona, hasStatus } from '../api';
import { CheckChips } from '../components/CheckChips';
import { ErrorBanner, Notice } from '../components/ErrorBanner';
import { EmptyNote } from '../components/parts';
import { canChecks, trustFactItems } from '../format';
import { CHANGE_CONFIRMED, useAction, useMeta, usePersonaName, useResource } from '../hooks';
import type { DemoRequest, EanAssociationResponse, OrgAction, OrgDetail } from '../types';
import { FactGrid } from './org/FactGrid';
import { PersonPicker } from './org/PersonPicker';
import { gateOf, pathOf, type Standing, standingOf } from './org/standing';

const ORG_ACTIONS: readonly OrgAction[] = ['view_own_request', 'view_profile', 'manage_members', 'invite', 'transfer_admin', 'request_ean_association'];

/** What opens once Great Eagle's four facts pass, while the persona's admin tools wait on them. */
const FACTS_NOTE: Partial<Record<Standing, string>> = {
  pending: 'Your admin tools open once all four pass and a Great Eagle reviewer approves you.',
  waiting: 'Your admin tools open once all four pass.',
  paused: 'Your admin tools come back once all four pass again.',
};

/** The current choice if it is still offered, else the first one: the lists change as people join. */
function picked(choice: string | undefined, options: readonly string[]): string {
  return choice !== undefined && options.includes(choice) ? choice : (options[0] ?? '');
}

/** The sign's status segment: Great Eagle's ownership check, except on a closed registration, which has no standing to sign. */
function ownershipAside(standing: Standing | undefined, verified: boolean) {
  if (standing === undefined || standing === 'closed') return undefined;
  return verified ? { icon: BadgeCheckIcon, text: 'Verified organization' } : { icon: ScanSearchIcon, text: 'Verification pending' };
}

/** Where the persona stands: the gate plate and its sentence, over the stages that brought them here. */
function StandingSign({ org, me, standing, orgName }: { org: OrgDetail; me: string; standing: Standing; orgName: string }) {
  const nameOf = usePersonaName();
  const gate = gateOf(org, me, standing, orgName, nameOf);
  const path = pathOf(org, me, standing, nameOf);
  return (
    <div role="status">
      <GateSign tone={gate.tone} icon={gate.icon} label={gate.label} title={gate.title} detail={gate.detail}>
        {path !== undefined && <StageStrip label={path.label} stages={path.stages} />}
      </GateSign>
    </div>
  );
}

/** One admin action as an inline panel: its title and the Permit decision that enables it, then its form. */
function ActionRow({ id, title, action, allow, children }: { id: string; title: string; action: OrgAction; allow: boolean | undefined; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-md border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={id} className="text-lg font-extrabold">
          {title}
        </h3>
        <CheckChips label={`Permit's decision on ${action}`} checks={[{ label: action, allow }]} />
      </div>
      {children}
    </section>
  );
}

/**
 * An organization as its user sees it: its sign, the gate sign for where the user stands,
 * Great Eagle's facts, Permit's decisions, members, EANs, and the admin actions, each enabled only when Permit allows it.
 * Read when it opens, after each action and when the tab is shown again, but not on a timer: a timer would re-ask
 * Permit every few seconds and fill the Audit Log with checks nobody made. `onMissing` is called when the
 * organization does not exist (404), so a parent can offer to create it.
 */
export function OrgPage({ orgKey, onMissing }: { orgKey: string; onMissing?: () => void }) {
  const me = getPersona();
  const meta = useMeta();
  const nameOf = usePersonaName();
  const path = `/api/s1/organizations/${encodeURIComponent(orgKey)}`;
  const org = useResource<OrgDetail>(path);
  const missing = hasStatus(org.error, 404);
  const action = useAction();
  const [notice, setNotice] = useState<string>();
  const [ean, setEan] = useState('EAN-2001');
  const [proof, setProof] = useState('');
  const [handoverReason, setHandoverReason] = useState('');
  const [colleagueChoice, setColleagueChoice] = useState<string>();
  const [nomineeChoice, setNomineeChoice] = useState<string>();

  useEffect(() => {
    if (missing) onMissing?.();
  }, [missing, onMissing]);

  if (missing && onMissing) return null;

  const send = async <T,>(task: () => Promise<T>, confirm: (result: T) => string) => {
    // The notice changes once, when the answer arrives: cleared up front, the page would jump twice.
    const result = await action.run(task);
    setNotice(result !== undefined ? confirm(result) : undefined);
    org.reload();
    return result;
  };

  const data = org.data;
  const orgName = data?.org.name ?? orgKey;
  const memberKeys = new Set(data?.members.map((m) => m.user) ?? []);
  // People Great Eagle knows at this company who are not members yet; in the demo, the company's other personas.
  const colleagues = meta.personas.filter((p) => p.company === orgName && p.key !== me && !memberKeys.has(p.key)).map((p) => p.key);
  // The admin role can go to any other member who does not already hold it.
  const nominees = (data?.members ?? []).filter((m) => m.user !== me && !m.roles.includes('org_admin')).map((m) => m.user);
  const colleague = picked(colleagueChoice, colleagues);
  const nominee = picked(nomineeChoice, nominees);
  const titleOf = (key: string) => meta.personas.find((p) => p.key === key)?.title;

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    await send(
      () => api.post<DemoRequest>(`${path}/invitations`, { user: colleague }),
      () => `Invitation sent to ${nameOf(colleague)}. It waits for ${nameOf(colleague)} to accept.`,
    );
  };

  const associate = async (e: FormEvent) => {
    e.preventDefault();
    const done = await send(
      () => api.post<EanAssociationResponse>(`${path}/ean-associations`, { ean: ean.trim(), proof: proof.trim() }),
      (r) => `${r.ean} is associated with this organization. ${CHANGE_CONFIRMED}`,
    );
    if (done) setProof('');
  };

  const handOver = async (e: FormEvent) => {
    e.preventDefault();
    const done = await send(
      () => api.post<DemoRequest>(`${path}/admin-transfers`, { to: nominee, reason: handoverReason.trim() }),
      () => `${nameOf(nominee)} is nominated as admin. The handover waits for ${nameOf(nominee)} to accept.`,
    );
    if (done) setHandoverReason('');
  };

  const stepDown = () => send(() => api.post<{ ok: true }>(`${path}/step-down`), () => 'You stepped down as admin.');

  const standing = data && standingOf(data, me);
  const can = data?.can;
  // The admin actions concern an admin, or a requester waiting to become one; others see only the decisions above.
  const myRoles = data?.members.find((m) => m.user === me)?.roles ?? [];
  const showAdminActions = myRoles.includes('org_admin') || myRoles.includes('pending_member');
  const aside = ownershipAside(standing, data?.facts.ownership_verified === true);
  // "All four" only holds when Great Eagle has the user's three facts beside the organization's ownership.
  const factsNote = standing === undefined || data?.facts.user === null ? undefined : FACTS_NOTE[standing];

  return (
    <div className="flex flex-col gap-6">
      <SignPlate id="org-title" title={orgName} aside={aside}>
        <p className="text-lg">
          Organization <code className="font-mono">{orgKey}</code>
        </p>
      </SignPlate>
      <ErrorBanner error={org.error} />
      {data === undefined || standing === undefined ? (
        org.error === undefined && <p className="text-muted-foreground">Loading the organization…</p>
      ) : (
        <>
          <StandingSign org={data} me={me} standing={standing} orgName={orgName} />

          <section aria-labelledby="org-facts-title" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <SectionHeading id="org-facts-title" title="Great Eagle's checks" />
              {factsNote !== undefined && <p className="text-muted-foreground">{factsNote}</p>}
            </div>
            <FactGrid label="Great Eagle's checks" items={trustFactItems(data.facts.user, data.facts.ownership_verified)} />
          </section>

          <section aria-labelledby="org-decisions-title" className="flex flex-col gap-3">
            <SectionHeading
              id="org-decisions-title"
              title="What Permit allows you here"
              action={
                // The page re-reads when its tab is shown again; with the console in a window beside it, this asks again.
                <Button variant="outline" size="lg" onClick={org.reload}>
                  <RefreshCwIcon data-icon="inline-start" />
                  Refresh
                </Button>
              }
            />
            <CheckChips label="Permit decisions for this organization" checks={canChecks(can, ORG_ACTIONS)} />
          </section>

          <section aria-labelledby="org-members-title" className="flex flex-col gap-3">
            <SectionHeading id="org-members-title" title="Members" />
            {data.members.length === 0 ? (
              <EmptyNote>No one holds a role in this organization yet.</EmptyNote>
            ) : (
              <ul className="flex flex-col rounded-md border border-border bg-surface">
                {data.members.map((m) => {
                  const title = titleOf(m.user);
                  return (
                    <li key={m.user} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3 last:border-b-0">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-semibold">
                          {nameOf(m.user)}
                          {m.user === me && ' (you)'}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          <code className="font-mono">{m.user}</code>
                          {title !== undefined && `, ${title}`}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {m.roles.map((role) => (
                          <code key={role} className="rounded-sm border border-foreground px-2 py-0.5 font-mono text-sm font-semibold">
                            {role}
                          </code>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="org-eans-title" className="flex flex-col gap-3">
            <SectionHeading id="org-eans-title" title="EANs" />
            {data.eans.length === 0 ? (
              <EmptyNote>No EANs are associated with this organization yet.</EmptyNote>
            ) : (
              <CheckChips label="Whether Permit allows you to view each EAN" checks={data.eans.map((e) => ({ label: `view ${e.key}`, allow: e.visible }))} />
            )}
          </section>

          {/* The outcome of an admin action, in place above the tools; outside them, so it stays once they go. */}
          <ErrorBanner error={action.error} onDismiss={action.clearError} />
          <Notice text={notice} onDismiss={() => setNotice(undefined)} />

          {showAdminActions && (
            <section aria-labelledby="org-admin-title" className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <SectionHeading id="org-admin-title" title="Admin actions" />
                <p className="text-muted-foreground">Each action is enabled only while Permit allows it.</p>
              </div>
              <ActionRow id="org-invite-title" title="Invite a colleague" action="invite" allow={can?.invite}>
                {colleagues.length === 0 ? (
                  <p className="text-muted-foreground">Everyone Great Eagle knows at {orgName} is already a member.</p>
                ) : (
                  <form className="flex flex-col gap-4" onSubmit={invite}>
                    <PersonPicker id="org-invite-colleague" label="Colleague" value={colleague} options={colleagues} nameOf={nameOf} onChange={setColleagueChoice} />
                    <div>
                      <Button type="submit" size="lg" disabled={!can?.invite || action.busy}>
                        <UserPlusIcon data-icon="inline-start" />
                        Send invitation
                      </Button>
                    </div>
                  </form>
                )}
              </ActionRow>
              <ActionRow id="org-ean-title" title="Associate an EAN" action="request_ean_association" allow={can?.request_ean_association}>
                <form className="flex flex-col gap-4" onSubmit={associate}>
                  <FieldGroup className="grid gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="org-ean">EAN</FieldLabel>
                      <Input id="org-ean" value={ean} required className="h-9 text-base md:text-base" onChange={(e) => setEan(e.target.value)} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="org-ean-proof">Proof of ownership</FieldLabel>
                      <Input
                        id="org-ean-proof"
                        value={proof}
                        required
                        placeholder="invoice number"
                        className="h-9 text-base md:text-base"
                        onChange={(e) => setProof(e.target.value)}
                      />
                      <FieldDescription>The account master checks it against its records.</FieldDescription>
                    </Field>
                  </FieldGroup>
                  <div>
                    <Button type="submit" size="lg" disabled={!can?.request_ean_association || action.busy || ean.trim() === '' || proof.trim() === ''}>
                      <LinkIcon data-icon="inline-start" />
                      Associate EAN
                    </Button>
                  </div>
                </form>
              </ActionRow>
              <ActionRow id="org-transfer-title" title="Transfer the admin role" action="transfer_admin" allow={can?.transfer_admin}>
                {nominees.length === 0 ? (
                  <p className="text-muted-foreground">The admin role can only go to a member. Invite a colleague first.</p>
                ) : (
                  <form className="flex flex-col gap-4" onSubmit={handOver}>
                    <FieldGroup className="grid gap-4 sm:grid-cols-2">
                      <PersonPicker id="org-transfer-nominee" label="New admin" value={nominee} options={nominees} nameOf={nameOf} onChange={setNomineeChoice} />
                      <Field className="sm:col-span-2">
                        <FieldLabel htmlFor="org-transfer-reason">Reason</FieldLabel>
                        <Input
                          id="org-transfer-reason"
                          value={handoverReason}
                          required
                          className="h-9 text-base md:text-base"
                          onChange={(e) => setHandoverReason(e.target.value)}
                        />
                        <FieldDescription>It goes on the handover request.</FieldDescription>
                      </Field>
                    </FieldGroup>
                    <div>
                      <Button type="submit" size="lg" disabled={!can?.transfer_admin || action.busy || handoverReason.trim() === ''}>
                        <UserRoundCheckIcon data-icon="inline-start" />
                        Nominate as admin
                      </Button>
                    </div>
                  </form>
                )}
              </ActionRow>
              <ActionRow id="org-step-down-title" title="Step down as admin" action="manage_members" allow={can?.manage_members}>
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                  <p className="text-muted-foreground">You stay a member of {orgName}.</p>
                  <Button variant="outline" size="lg" disabled={!can?.manage_members || action.busy} onClick={stepDown}>
                    <LogOutIcon data-icon="inline-start" />
                    Step down
                  </Button>
                </div>
              </ActionRow>
            </section>
          )}
        </>
      )}
    </div>
  );
}
