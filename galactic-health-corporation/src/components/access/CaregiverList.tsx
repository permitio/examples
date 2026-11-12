'use client';

import { Alert, Button, CircularProgress, Skeleton, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';
import type { Caregiver } from '@/lib/resources';

async function fetchCaregivers(signal: AbortSignal): Promise<Caregiver[]> {
  const response = await fetch('/api/account/caregiver', { signal });
  if (!response.ok) throw new Error(`/api/account/caregiver answered ${response.status}`);
  return (await response.json()) as Caregiver[];
}

const SHARED_DATA_LABELS: Record<Caregiver['resource'], string> = {
  member: 'Account and health data',
  health_plan: 'Health plan',
  medical_records: 'Medical records',
};

function formatDate(value: string): string {
  return value === '' ? 'N/A' : new Date(value).toLocaleString();
}

function rowKey(caregiver: Caregiver): string {
  return `${caregiver.user.id}:${caregiver.resource}`;
}

function RevokeButton({ revoking, onRevoke }: { revoking: boolean; onRevoke: () => void }) {
  return (
    <Button onClick={onRevoke} variant="contained" color="error" disabled={revoking}>
      {revoking ? <CircularProgress size={20} color="inherit" className="mr-2" /> : null}
      Revoke Permissions
    </Button>
  );
}

/** The signed-in member's caregivers, with a button to revoke each grant. */
export function CaregiverList() {
  const [caregivers, setCaregivers] = useState<Caregiver[] | null>(null);
  const [revoking, setRevoking] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const isMobile = useMediaQuery(useTheme().breakpoints.down('sm'));

  useEffect(() => {
    const controller = new AbortController();
    fetchCaregivers(controller.signal).then(setCaregivers, (cause: unknown) => {
      if (controller.signal.aborted) return;
      console.error('Could not load your caregivers', cause);
      setError('Could not load your caregivers.');
      setCaregivers([]);
    });
    return () => controller.abort();
  }, [version]);

  const revoke = async (caregiver: Caregiver) => {
    setRevoking(rowKey(caregiver));
    setError('');
    try {
      const response = await fetch(
        `/api/account/caregiver/${encodeURIComponent(caregiver.user.id)}/${caregiver.resource}`,
        { method: 'DELETE' },
      );
      if (!response.ok) throw new Error(`Revoking answered ${response.status}`);
      setVersion((previous) => previous + 1);
    } catch (cause) {
      console.error('Could not revoke the caregiver', cause);
      setError('Could not revoke this caregiver.');
    } finally {
      setRevoking('');
    }
  };

  return (
    <>
      <h2 className="my-2 font-semibold text-sky-600">Caregiver Access</h2>
      {error === '' ? null : <Alert severity="error">{error}</Alert>}
      <div className="overflow-hidden border-b border-gray-200 shadow-sm sm:rounded-lg">
        {caregivers === null ? <Skeleton variant="rectangular" height={40} /> : null}
        {caregivers?.length === 0 ? (
          <p className="px-6 py-4 text-center text-gray-500">No caregivers found.</p>
        ) : null}
        {caregivers !== null && caregivers.length > 0 && isMobile ? (
          <div>
            {caregivers.map((caregiver) => (
              <div className="m-2 rounded-sm border border-gray-200 p-4" key={rowKey(caregiver)}>
                <div className="mb-2 text-xs font-bold">Full Name</div>
                <div className="mb-4">
                  {caregiver.user.firstName} {caregiver.user.lastName}
                </div>
                <div className="mb-2 text-xs font-bold">Start Date</div>
                <div className="mb-4">{formatDate(caregiver.startDate)}</div>
                <div className="mb-2 text-xs font-bold">End Date</div>
                <div className="mb-4">{formatDate(caregiver.endDate)}</div>
                <div className="mb-2 text-xs font-bold">Shared Data</div>
                <div className="mb-4">{SHARED_DATA_LABELS[caregiver.resource]}</div>
                <RevokeButton
                  revoking={revoking === rowKey(caregiver)}
                  onRevoke={() => void revoke(caregiver)}
                />
              </div>
            ))}
          </div>
        ) : null}
        {caregivers !== null && caregivers.length > 0 && !isMobile ? (
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {['Full Name', 'Start Date', 'End Date', 'Shared Data', ''].map((heading) => (
                  <th
                    key={heading}
                    className="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {caregivers.map((caregiver) => (
                <tr key={rowKey(caregiver)}>
                  <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-900">
                    {caregiver.user.firstName} {caregiver.user.lastName}
                  </td>
                  <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-500">
                    {formatDate(caregiver.startDate)}
                  </td>
                  <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-500">
                    {formatDate(caregiver.endDate)}
                  </td>
                  <td className="px-6 py-4 text-sm whitespace-nowrap text-gray-500">
                    {SHARED_DATA_LABELS[caregiver.resource]}
                  </td>
                  <td className="px-6 py-4 text-right text-sm font-medium whitespace-nowrap">
                    <RevokeButton
                      revoking={revoking === rowKey(caregiver)}
                      onRevoke={() => void revoke(caregiver)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}
