'use client';

import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs, { type Dayjs } from 'dayjs';
import { useWizardForm } from '@/contexts/WizardFormContext';

const NOTES = [
  'You are granting PHI access with the Release of Information under HIPAA laws and sharing ' +
    'Protected Health Information (PHI).',
  'You have selected to give Galactic Health Corporation and its affiliates permission to share ' +
    'your personal information. Shared information could include Protected Health Information ' +
    '(PHI).',
  "Shared access to a dependent's information will end automatically when the dependent reaches " +
    'age 12, regardless of the date selected above.',
  'You can control access by using this website or calling the number on the back of your ' +
    'medical card.',
];

function iso(value: Dayjs | null): string {
  return value?.isValid() ? value.startOf('minute').toISOString() : '';
}

/**
 * The window of the caregiver grant. The app stores it as the `caregiver_bounds` user attribute;
 * the optional custom Rego policy enforces it (ABAC).
 */
export function AccessLength() {
  const { formState, setFormState } = useWizardForm();
  const start = formState.start === '' ? null : dayjs(formState.start);
  const end = formState.end === '' ? null : dayjs(formState.end);

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <div className="my-12 flex flex-col space-y-4">
        <div>
          <span className="mb-1 block">Start on</span>
          <DateTimePicker
            label="Start Date"
            value={start}
            onChange={(value) => setFormState((previous) => ({ ...previous, start: iso(value) }))}
          />
        </div>
        <div>
          <span className="mb-1 block">End on</span>
          <DateTimePicker
            label="End Date"
            value={end}
            onChange={(value) => setFormState((previous) => ({ ...previous, end: iso(value) }))}
            {...(start === null ? {} : { minDateTime: start, maxDateTime: start.add(1, 'year') })}
          />
          <span className="mt-1 block text-sm text-gray-500">Maximum of one year</span>
        </div>
        <h2 className="mb-2 text-lg font-semibold">What to know</h2>
        <ul className="ml-5 list-disc">
          {NOTES.map((note) => (
            <li key={note} className="mb-4">
              {note}
            </li>
          ))}
        </ul>
      </div>
    </LocalizationProvider>
  );
}
