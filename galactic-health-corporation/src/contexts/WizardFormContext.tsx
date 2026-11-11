'use client';

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useMemo,
  useState,
} from 'react';
import type { Person, SharingOption } from '@/lib/resources';

export const DELEGATION_TYPES = [
  'Account & Health Data',
  'Power of Attorney, Guardian or Conservator',
] as const;
export type DelegationType = (typeof DELEGATION_TYPES)[number];

export interface FormState {
  step: number;
  delegationType: DelegationType;
  sharing: SharingOption;
  selectedPerson: Person | null;
  /** ISO 8601 bounds of the caregiver grant. */
  start: string;
  end: string;
  consent: boolean;
  signature: string;
}

export const INITIAL_FORM_STATE: FormState = {
  step: 1,
  delegationType: 'Account & Health Data',
  sharing: 'health_plan',
  selectedPerson: null,
  start: '',
  end: '',
  consent: false,
  signature: '',
};

interface WizardFormContextValue {
  formState: FormState;
  setFormState: Dispatch<SetStateAction<FormState>>;
}

const WizardFormContext = createContext<WizardFormContextValue | null>(null);

export function WizardFormProvider({ children }: { children: ReactNode }) {
  const [formState, setFormState] = useState(INITIAL_FORM_STATE);
  const value = useMemo(() => ({ formState, setFormState }), [formState]);
  return <WizardFormContext value={value}>{children}</WizardFormContext>;
}

export function useWizardForm(): WizardFormContextValue {
  const context = use(WizardFormContext);
  if (context === null) throw new Error('useWizardForm must be used inside a WizardFormProvider.');
  return context;
}
