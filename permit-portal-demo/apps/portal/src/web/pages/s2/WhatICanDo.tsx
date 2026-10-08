import { ArrowRightIcon, MapPinIcon, RefreshCwIcon } from 'lucide-react';
import { getPersona } from '@/api';
import { ErrorBanner } from '@/components/ErrorBanner';
import { EmptyNote, Heading, Lede, Tag } from '@/components/parts';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useResource } from '@/hooks';
import { PagePlate } from '../s4/parts';
import { groupRows } from './team';
import type { PermissionRow, PermissionsResponse } from './types';

/** One kind of resource as a framed table: where, the roles held there, and the actions they allow. */
function PermissionTable({ id, title, rows }: { id: string; title: string; rows: PermissionRow[] }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <Heading id={id} title={title} count={rows.length} />
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        {/* Fixed columns, so the three tables line up with one another; the minimum width scrolls the table on a phone instead of squeezing it. */}
        <Table className="min-w-[38rem] table-fixed text-base" aria-labelledby={id}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="w-[30%] px-4 font-bold">
                Where
              </TableHead>
              <TableHead scope="col" className="w-[30%] px-4 font-bold">
                Roles
              </TableHead>
              <TableHead scope="col" className="px-4 font-bold">
                Allowed actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.resource} className="hover:bg-transparent">
                <TableCell className="px-4 py-2.5">
                  <span className="flex flex-col">
                    <span className="font-semibold">{row.name}</span>
                    <code className="font-mono text-sm text-muted-foreground">{row.resource}</code>
                  </span>
                </TableCell>
                <TableCell className="px-4 py-2.5">
                  {row.roles.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      {row.roles.map((role) => (
                        <code key={role} className="rounded-sm border border-foreground px-2 py-0.5 font-mono text-sm font-semibold">
                          {role}
                        </code>
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-2.5">
                  {row.actions.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      {row.actions.map((a) => (
                        <Tag key={a} tone="go" icon={ArrowRightIcon} label={a} />
                      ))}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/**
 * S2's "What I can do", for Merry: what Permit lets Merry do on each EAN, child account and location,
 * from the PDP's user-permissions answer. The route (GET /api/s2/permissions/:user) answers only for the persona asking,
 * so the page asks for the signed-in persona's own. A resource Permit does not list is not here, so Merry sees only the
 * depots Merry operates. Read when it opens and when its tab is shown again, but not on a timer. A failed read is an
 * error, never "nothing allowed".
 */
export function WhatICanDo() {
  const permissions = useResource<PermissionsResponse>(`/api/s2/permissions/${encodeURIComponent(getPersona())}`);
  const rows = permissions.data?.rows;
  const aside = rows && { icon: MapPinIcon, text: `${rows.length} ${rows.length === 1 ? 'place' : 'places'}` };

  return (
    <div className="flex flex-col gap-6">
      <PagePlate title="What I can do" aside={aside} />
      <div className="-mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <Lede>What Permit lets you do on each EAN, child account and location.</Lede>
        <Button variant="outline" size="lg" onClick={permissions.reload}>
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <ErrorBanner error={permissions.error} />
      {rows === undefined ? (
        permissions.error === undefined && <p className="text-muted-foreground">Loading what Permit allows…</p>
      ) : rows.length === 0 ? (
        <EmptyNote>You can't act on any account yet.</EmptyNote>
      ) : (
        groupRows(rows).map((group) => <PermissionTable key={group.type} id={`permissions-${group.type}`} title={group.title} rows={group.rows} />)
      )}
    </div>
  );
}
