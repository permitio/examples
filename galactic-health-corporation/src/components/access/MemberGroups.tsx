'use client';

import AddCircleIcon from '@mui/icons-material/AddCircle';
import AddCircleOutlinedIcon from '@mui/icons-material/AddCircleOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import GroupIcon from '@mui/icons-material/Group';
import {
  Alert,
  Avatar,
  Button,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemAvatar,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Skeleton,
  TextField,
} from '@mui/material';
import { Fragment, useEffect, useState } from 'react';
import type { MemberGroup } from '@/lib/resources';

async function fetchGroups(signal: AbortSignal): Promise<MemberGroup[]> {
  const response = await fetch('/api/account/member-groups', { signal });
  if (!response.ok) throw new Error(`/api/account/member-groups answered ${response.status}`);
  return (await response.json()) as MemberGroup[];
}

/** Sends a JSON request and returns the API's error message, or '' when it succeeded. */
async function send(url: string, method: 'POST' | 'DELETE', body: unknown): Promise<string> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.ok) return '';
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `The request failed (${response.status}).`;
}

/** A dialog with one text field, for a group name or a member's email. */
function PromptDialog({
  title,
  label,
  open,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<string>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    setValue('');
    setError('');
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    const message = await onSubmit(value);
    setBusy(false);
    if (message === '') close();
    else setError(message);
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : close} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {error === '' ? null : <Alert severity="error">{error}</Alert>}
        <TextField
          margin="dense"
          label={label}
          fullWidth
          variant="standard"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={busy || value.trim() === ''}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The member groups the signed-in member administers. Adding someone to a group gives them the
 * group's org_member role, which lets them read the profiles in it and makes them someone the admin
 * can delegate access to.
 */
export function MemberGroups() {
  const [groups, setGroups] = useState<MemberGroup[] | null>(null);
  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [addingGroup, setAddingGroup] = useState(false);
  const [addingMemberTo, setAddingMemberTo] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetchGroups(controller.signal).then(setGroups, (cause: unknown) => {
      if (controller.signal.aborted) return;
      console.error('Could not load your member groups', cause);
      setError('Could not load your member groups.');
      setGroups([]);
    });
    return () => controller.abort();
  }, [version]);

  const reload = () => {
    setGroups(null);
    setVersion((previous) => previous + 1);
  };

  const run = async (request: Promise<string>) => {
    setError(await request);
    reload();
  };

  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const addGroup = async (name: string) => {
    const message = await send('/api/account/member-groups', 'POST', { name });
    if (message === '') reload();
    return message;
  };

  const addMember = async (email: string) => {
    const message = await send('/api/account/member-groups/assign', 'POST', {
      email,
      group: addingMemberTo,
    });
    if (message === '') reload();
    return message;
  };

  return (
    <div>
      <h2 className="my-2 mb-2 font-semibold text-sky-600">Member Groups</h2>
      {error === '' ? null : <Alert severity="error">{error}</Alert>}
      <Paper className="mb-2">
        {groups === null ? (
          <Skeleton height={80} className="mx-7" />
        ) : (
          <List>
            {groups.map(({ key, name, members }) => (
              <Fragment key={key}>
                <ListItem
                  disablePadding
                  secondaryAction={
                    <IconButton
                      edge="end"
                      aria-label={`Delete ${name}`}
                      onClick={() =>
                        void run(send('/api/account/member-groups', 'DELETE', { key }))
                      }
                    >
                      <DeleteIcon />
                    </IconButton>
                  }
                >
                  <ListItemButton onClick={() => toggle(key)}>
                    <ListItemIcon sx={{ minWidth: '36px' }}>
                      {expanded.has(key) ? <ExpandMoreIcon /> : <ChevronRightIcon />}
                    </ListItemIcon>
                    <ListItemAvatar>
                      <Avatar>
                        <GroupIcon />
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText primary={name} />
                  </ListItemButton>
                </ListItem>
                <Collapse
                  in={expanded.has(key)}
                  timeout="auto"
                  unmountOnExit
                  className="bg-slate-50"
                >
                  <List component="div" disablePadding className="ml-4 pl-4">
                    {members.map((member) => (
                      <ListItem
                        key={member.id}
                        secondaryAction={
                          <IconButton
                            edge="end"
                            aria-label={`Remove ${member.firstName} from ${name}`}
                            onClick={() =>
                              void run(
                                send('/api/account/member-groups/unassign', 'POST', {
                                  member: member.id,
                                  group: key,
                                }),
                              )
                            }
                          >
                            <DeleteIcon />
                          </IconButton>
                        }
                      >
                        <ListItemAvatar>
                          <Avatar>{member.firstName.charAt(0)}</Avatar>
                        </ListItemAvatar>
                        <ListItemText
                          primary={`${member.firstName} ${member.lastName}`}
                          secondary={member.email}
                        />
                      </ListItem>
                    ))}
                    <ListItemButton onClick={() => setAddingMemberTo(key)}>
                      <ListItemIcon>
                        <AddCircleOutlinedIcon />
                      </ListItemIcon>
                      <ListItemText primary="Add Member" />
                    </ListItemButton>
                  </List>
                </Collapse>
              </Fragment>
            ))}
            <ListItemButton onClick={() => setAddingGroup(true)}>
              <ListItemIcon sx={{ minWidth: '36px' }}>
                <AddCircleIcon />
              </ListItemIcon>
              <ListItemText primary="Add Member Group" />
            </ListItemButton>
          </List>
        )}
      </Paper>
      <PromptDialog
        title="Add Member Group"
        label="Group Name"
        open={addingGroup}
        onClose={() => setAddingGroup(false)}
        onSubmit={addGroup}
      />
      <PromptDialog
        title="Add Member"
        label="Member Email"
        open={addingMemberTo !== ''}
        onClose={() => setAddingMemberTo('')}
        onSubmit={addMember}
      />
    </div>
  );
}
