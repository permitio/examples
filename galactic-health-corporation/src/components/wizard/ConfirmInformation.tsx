'use client';

import InfoIcon from '@mui/icons-material/Info';
import { Box, Checkbox, FormControlLabel } from '@mui/material';
import dayjs from 'dayjs';
import { type UIEvent, useState } from 'react';
import { PersonDetails } from '@/components/wizard/PersonDetails';
import { useWizardForm } from '@/contexts/WizardFormContext';
import consent from '@/data/lorem-ipsum.json';

const AGREEMENTS = [
  'I validate that my full name as it appears above is accurate.',
  'I indicate my agreement to use electronic records and signatures to sign this form ' +
    'electronically.',
  'I acknowledge that I have read, understand and intend to indicate my agreement to all of the ' +
    'terms above.',
  'I understand that I have a right to receive a copy of this authorization.',
];

/** The review step: the chosen person and dates, the release text, consent and signature. */
export function ConfirmInformation() {
  const { formState, setFormState } = useWizardForm();
  const [scrolledToEnd, setScrolledToEnd] = useState(false);

  const checkEnd = (element: HTMLDivElement | null) => {
    if (element === null) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    if (scrollTop + clientHeight >= scrollHeight - 1) setScrolledToEnd(true);
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => checkEnd(event.currentTarget);

  return (
    <div className="my-12 flex flex-col space-y-6">
      <h2 className="mb-2 text-xl font-semibold">Review, sign and submit</h2>
      <div>
        <p className="mb-2">
          Please review the following information and confirm that you want to share access to your
          health plan information.
        </p>
        <Box className="rounded-sm border border-gray-200 p-4">
          {formState.selectedPerson === null ? (
            <p>No person selected. Go back and pick one.</p>
          ) : (
            <PersonDetails person={formState.selectedPerson} />
          )}
        </Box>
      </div>
      <div>
        <Box className="rounded-sm border border-gray-200 p-4">
          <div className="mb-3 ml-6 flex flex-col">
            <span className="font-bold">Start Date:</span>
            {new Date(formState.start).toLocaleString()}
          </div>
          <div className="mb-3 ml-6 flex flex-col">
            <span className="font-bold">End Date:</span>
            {new Date(formState.end).toLocaleString()}
          </div>
        </Box>
        <p className="mt-6 mb-2">
          Please scroll through, read and acknowledge the below statements before you eSign.
        </p>
        {/* On a wide screen the text may fit without scrolling; the ref then counts it as read. */}
        <div
          className="mb-10 max-h-[300px] overflow-y-auto rounded-sm border border-gray-200 p-4"
          onScroll={onScroll}
          ref={checkEnd}
        >
          <p>{consent['lorem-ipsum']}</p>
        </div>
        <Box className="flex items-center rounded-sm border-l-4 border-blue-400 bg-blue-100 p-2">
          <InfoIcon className="mr-2 text-sky-600" />
          <span>
            <strong>Note:</strong> You need to scroll through the information above before you can
            check the box.
          </span>
        </Box>
        <FormControlLabel
          className="mt-2"
          control={
            <Checkbox
              checked={formState.consent}
              disabled={!scrolledToEnd}
              onChange={(event) =>
                setFormState((previous) => ({ ...previous, consent: event.target.checked }))
              }
            />
          }
          label="By checking this box and signing below, I acknowledge that I have read, understand and agree to all of the above"
        />
      </div>
      <div>
        <label className="mb-2 block font-semibold" htmlFor="signature">
          Please enter your full name in order to electronically sign this document.
        </label>
        <input
          id="signature"
          type="text"
          value={formState.signature}
          onChange={(event) =>
            setFormState((previous) => ({ ...previous, signature: event.target.value }))
          }
          className="mb-2 w-full rounded-sm border border-gray-300 p-2"
        />
        <p className="text-sm text-gray-500">Date: {dayjs().format('DD/MM/YYYY')}</p>
      </div>
      <h2 className="mb-2 text-lg font-semibold">
        By selecting &quot;Submit&quot; I agree to the following:
      </h2>
      <ul className="ml-5 list-disc">
        {AGREEMENTS.map((agreement) => (
          <li key={agreement} className="mb-4">
            {agreement}
          </li>
        ))}
      </ul>
    </div>
  );
}
