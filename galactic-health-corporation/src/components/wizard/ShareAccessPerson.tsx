'use client';

import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  type SelectChangeEvent,
  Skeleton,
} from '@mui/material';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PersonDetails } from '@/components/wizard/PersonDetails';
import { useWizardForm } from '@/contexts/WizardFormContext';
import type { Person } from '@/lib/resources';

/** Picks the caregiver from the members of the groups the signed-in member administers. */
export function ShareAccessPerson() {
  const { formState, setFormState } = useWizardForm();
  const [persons, setPersons] = useState<Person[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/account/member', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`/api/account/member answered ${response.status}`);
        setPersons((await response.json()) as Person[]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Could not load your group members', error);
        setPersons([]);
      });
    return () => controller.abort();
  }, []);

  const select = (event: SelectChangeEvent) => {
    const person = persons?.find((candidate) => candidate.id === event.target.value) ?? null;
    setFormState((previous) => ({ ...previous, selectedPerson: person }));
  };

  const selected = formState.selectedPerson;

  return (
    <div>
      <h2 className="mt-10 mb-8 text-xl font-semibold">Who do you want to have this access?</h2>
      <div className="mb-12">
        {persons === null ? (
          <Skeleton variant="rectangular" className="w-full" height={50} />
        ) : null}
        {persons?.length === 0 ? (
          <>
            <p className="font-semibold">No members found.</p>
            <p className="text-gray-500">
              To add a member,{' '}
              <Link href="/access" className="text-sky-600">
                add them to your member groups
              </Link>{' '}
              in your account.
            </p>
          </>
        ) : null}
        {persons !== null && persons.length > 0 ? (
          <FormControl fullWidth>
            <InputLabel id="person-label">Person</InputLabel>
            <Select
              labelId="person-label"
              value={selected?.id ?? ''}
              label="Person"
              onChange={select}
            >
              {persons.map((person) => (
                <MenuItem key={person.id} value={person.id}>
                  {person.firstName} {person.lastName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
      </div>
      {selected === null ? null : (
        <>
          <div className="mb-12 flex flex-col">
            <span className="font-bold">Provide or confirm their personal information</span>
            <span>
              The information below cannot be changed if pre-populated, but you can add any missing
              information. If any pre-populated information is incorrect, please call member
              services at 1-800-555-5555 to update the information.
            </span>
          </div>
          <div className="mb-12">
            <PersonDetails person={selected} />
          </div>
        </>
      )}
    </div>
  );
}
