'use client';

import { Radio } from '@mui/material';
import { DELEGATION_TYPES, type DelegationType, useWizardForm } from '@/contexts/WizardFormContext';

const DESCRIPTIONS: Record<DelegationType, { title: string; text: string }> = {
  'Account & Health Data': {
    title: 'Share access to your account or health data',
    text:
      'Choose this option if you want someone to be able to access and manage your plan. Or, ' +
      'if you want to allow access to your Protected Health Information (PHI), by agreeing to ' +
      'a HIPAA Release of Information.',
  },
  'Power of Attorney, Guardian or Conservator': {
    title: 'Provide access for a Power of Attorney, Guardian, or Conservator',
    text:
      'We will need to receive a copy of the legal documentation to grant access, and the ' +
      'access is based on the specific documentation.',
  },
};

export function DelegatePermissions() {
  const { formState, setFormState } = useWizardForm();

  return (
    <div className="px-4 md:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold text-sky-600 md:text-4xl">Share access to your plan</h1>
      <p className="mt-4 text-sm md:text-base">
        If you&apos;d like others to have access to your health plan, you have options for what you
        share.
      </p>
      <h2 className="mt-10 text-xl font-semibold md:text-2xl">
        Choose the type of access you want to share
      </h2>
      <div className="mt-4 mb-12 flex flex-col md:flex-row">
        {DELEGATION_TYPES.map((type, index) => (
          <label
            key={type}
            htmlFor={`delegation-${index}`}
            className={`flex h-full w-full cursor-pointer py-5 md:w-1/2 md:p-5 ${
              index === 0 ? 'border-b border-black md:border-0 md:border-r' : 'md:ml-6'
            }`}
          >
            <div className="w-1/5">
              <Radio
                checked={formState.delegationType === type}
                onChange={() => setFormState((previous) => ({ ...previous, delegationType: type }))}
                value={type}
                name="delegation-type"
                slotProps={{ input: { 'aria-label': type } }}
              />
            </div>
            <div className="w-4/5">
              <h3 className="mb-4 text-lg font-medium">{DESCRIPTIONS[type].title}</h3>
              <span>{DESCRIPTIONS[type].text}</span>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
