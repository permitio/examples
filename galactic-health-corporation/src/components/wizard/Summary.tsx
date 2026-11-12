'use client';

import Link from 'next/link';
import { useWizardForm } from '@/contexts/WizardFormContext';

export function Summary() {
  const { selectedPerson, end } = useWizardForm().formState;
  if (selectedPerson === null) return null;
  const name = selectedPerson.firstName;

  return (
    <div className="my-12">
      <h2 className="mt-10 mb-6 text-2xl font-semibold">
        Success! You&apos;ve set up shared access for {name}
      </h2>
      <span>{name} can now open your dashboard from the plan selector on their My Plan page.</span>
      <h3 className="mt-6 mb-4 text-lg font-medium">Manage their access</h3>
      <span>
        You can manage shared access at any time on the{' '}
        <Link href="/access" className="text-sky-600">
          Control Access
        </Link>{' '}
        page.
      </span>
      <h2 className="mt-10 mb-6 text-xl font-semibold">
        {name} will have shared access until {new Date(end).toLocaleString()}.
      </h2>
    </div>
  );
}
