'use client';

import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RemoveCircleIcon from '@mui/icons-material/RemoveCircle';
import { Radio } from '@mui/material';
import { useWizardForm } from '@/contexts/WizardFormContext';
import type { SharingOption } from '@/lib/resources';

/** The three ways to share, each mapped to the Permit resource the caregiver role is put on. */
const OPTIONS: { value: SharingOption; title: string; text: string; abilities: string[] }[] = [
  {
    value: 'health_plan',
    title: 'Share account access',
    text:
      'The person you share account access with must be a member on your plan. They will be ' +
      'able to see the same information and take the same actions you can, with few ' +
      'exceptions. For example, they will be able to:',
    abilities: [
      'View medical claims and family level deductible and coinsurance/out of pocket maximums',
      'Access sensitive information for children 12 and under',
      'View the Health Savings Account balance',
    ],
  },
  {
    value: 'medical_records',
    title: 'Share your health data',
    text:
      'You can choose to share your Protected Health Information (PHI) with a person by ' +
      'agreeing to a HIPAA Release of Information. This will enable them to do the following:',
    abilities: [
      'Discuss your sensitive information with customer service',
      'View your individual health records',
      'File appeals and grievances on your behalf',
    ],
  },
  {
    value: 'member',
    title: 'Share both your account access and your health data',
    text:
      'This option gives access to both, your health plan account and your Protected Health ' +
      'Information (PHI), as described above.',
    abilities: [],
  },
];

const NOT_SHARED = [
  'Sensitive information for members age 13 and older',
  'The ability to pay claims from the web portal or mobile app',
];

export function ShareAccess() {
  const { formState, setFormState } = useWizardForm();

  return (
    <div className="px-4 md:px-0">
      <h2 className="mt-10 text-xl font-semibold">What would you like to share?</h2>
      <span>You can choose to share your account access, your health data, or both.</span>
      <div className="mt-4 mb-12 grid grid-cols-1 gap-4 md:grid-cols-3">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            htmlFor={`sharing-${option.value}`}
            className="flex w-full cursor-pointer flex-col rounded-lg border border-gray-300 p-5 md:flex-row"
          >
            <div className="w-full md:w-1/5">
              <Radio
                checked={formState.sharing === option.value}
                onChange={() =>
                  setFormState((previous) => ({ ...previous, sharing: option.value }))
                }
                value={option.value}
                name="sharing"
                slotProps={{ input: { 'aria-label': option.title } }}
              />
            </div>
            <div className="w-full pr-4 md:w-4/5">
              <h3 className="mb-4 text-lg font-medium">{option.title}</h3>
              <span>{option.text}</span>
              {option.abilities.map((ability) => (
                <div key={ability} className="mt-4 flex">
                  <CheckCircleIcon color="success" fontSize="small" />
                  <span className="ml-3">{ability}</span>
                </div>
              ))}
            </div>
          </label>
        ))}
      </div>
      <div className="mb-12 flex flex-col">
        <h3 className="mb-4 text-lg font-medium">The following cannot be shared:</h3>
        {NOT_SHARED.map((item) => (
          <div key={item} className="mt-4 flex">
            <RemoveCircleIcon sx={{ color: 'red' }} fontSize="small" />
            <span className="ml-3">{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
