import { redirect } from 'next/navigation';
import { AccountApp } from '@/components/AccountApp';
import type { ElementsConfig } from '@/lib/api-types';
import { currentUser } from '@/lib/current-user';
import { elementsSettings } from '@/lib/env';
import { describeError } from '@/lib/http';
import { getEnvironmentId } from '@/lib/permit';

/** Where the browser loads Permit Elements from, or null when Permit could not be reached. */
async function elementsConfig(): Promise<ElementsConfig | null> {
  try {
    return { envId: await getEnvironmentId(), ...elementsSettings() };
  } catch (error) {
    console.error(`[account] Permit Elements are off: ${describeError(error)}`);
    return null;
  }
}

export default async function AccountPage() {
  const user = await currentUser();
  if (user === null) redirect('/');
  return (
    <AccountApp user={{ email: user.email, name: user.name }} elements={await elementsConfig()} />
  );
}
