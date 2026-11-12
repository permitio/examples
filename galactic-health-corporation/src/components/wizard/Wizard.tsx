'use client';

import { Alert, Step, StepLabel, Stepper } from '@mui/material';
import dayjs from 'dayjs';
import { useState } from 'react';
import { AccessLength } from '@/components/wizard/AccessLength';
import { ConfirmInformation } from '@/components/wizard/ConfirmInformation';
import { DelegatePermissions } from '@/components/wizard/DelegatePermissions';
import { ShareAccess } from '@/components/wizard/ShareAccess';
import { ShareAccessPerson } from '@/components/wizard/ShareAccessPerson';
import { Summary } from '@/components/wizard/Summary';
import { type FormState, INITIAL_FORM_STATE, useWizardForm } from '@/contexts/WizardFormContext';
import type { CaregiverRequest } from '@/lib/resources';

const STEP_LABELS = [
  'Choose what to share',
  'Who to share with',
  'Set access period',
  'Review and submit',
];
const STEPS = [
  DelegatePermissions,
  ShareAccess,
  ShareAccessPerson,
  AccessLength,
  ConfirmInformation,
  Summary,
];
const PERSON_STEP = 3;
const REVIEW_STEP = 5;
const DONE_STEP = 6;

const BUTTON = 'mt-4 mr-4 w-32 cursor-pointer rounded-3xl border border-blue-900 px-3 py-1';
const PRIMARY = `${BUTTON} bg-blue-900 text-white disabled:cursor-not-allowed disabled:opacity-50`;

function canContinue(state: FormState): boolean {
  if (state.step === PERSON_STEP) return state.selectedPerson !== null;
  if (state.step === REVIEW_STEP) return state.consent && state.signature.trim() !== '';
  return true;
}

/** Leaving the person step starts the access period now and ends it a week later. */
function withDefaultPeriod(state: FormState): FormState {
  if (state.start !== '') return state;
  const start = dayjs().startOf('minute');
  return { ...state, start: start.toISOString(), end: start.add(1, 'week').toISOString() };
}

/** The Delegate Permissions wizard: its last step makes the chosen member a caregiver. */
export function Wizard() {
  const { formState, setFormState } = useWizardForm();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const StepComponent = STEPS[formState.step - 1] ?? DelegatePermissions;

  const next = () =>
    setFormState((previous) => {
      const advanced = { ...previous, step: previous.step + 1 };
      return previous.step === PERSON_STEP ? withDefaultPeriod(advanced) : advanced;
    });
  const back = () => setFormState((previous) => ({ ...previous, step: previous.step - 1 }));
  const cancel = () => {
    setError('');
    setFormState(INITIAL_FORM_STATE);
  };

  const submit = async () => {
    const { selectedPerson, sharing, start, end } = formState;
    if (selectedPerson === null) return;
    const body: CaregiverRequest = {
      user: selectedPerson.id,
      resource: sharing,
      startDate: start,
      endDate: end,
    };
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/account/caregiver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Could not share access (${response.status}).`);
        return;
      }
      next();
    } catch (cause) {
      console.error('Could not assign the caregiver', cause);
      setError('Could not share access.');
    } finally {
      setSubmitting(false);
    }
  };

  const inProgress = formState.step > 1 && formState.step < DONE_STEP;

  return (
    <div>
      {inProgress ? (
        <Stepper activeStep={formState.step - 2} alternativeLabel>
          {STEP_LABELS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>
      ) : null}
      <StepComponent />
      {error === '' ? null : <Alert severity="error">{error}</Alert>}
      {inProgress ? (
        <button type="button" onClick={back} className={BUTTON}>
          Back
        </button>
      ) : null}
      {formState.step < DONE_STEP ? (
        <button type="button" onClick={cancel} className={BUTTON}>
          Cancel
        </button>
      ) : null}
      {formState.step < REVIEW_STEP ? (
        <button type="button" onClick={next} disabled={!canContinue(formState)} className={PRIMARY}>
          Next
        </button>
      ) : null}
      {formState.step === REVIEW_STEP ? (
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !canContinue(formState)}
          className={PRIMARY}
        >
          Submit
        </button>
      ) : null}
      {formState.step === DONE_STEP ? (
        <button type="button" onClick={cancel} className={PRIMARY}>
          Start over
        </button>
      ) : null}
    </div>
  );
}
