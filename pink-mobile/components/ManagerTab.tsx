import { Button, Card, HStack, Input, List, Text, VStack } from '@chakra-ui/react';
import { useState, useTransition, type FormEvent } from 'react';
import { ErrorAlert } from '#components/ErrorAlert';
import { apiPath, callApi } from '#lib/client';
import { MANAGER_KEY, fullName, type Representative } from '#lib/model';

interface ManagerTabProps {
  representatives: readonly Representative[];
  /** Reloads the representatives after an assignment changes. */
  onChanged: () => Promise<void>;
}

interface RepresentativeCardProps {
  representative: Representative;
  onAssign: (customerEmail: string) => Promise<boolean>;
  onUnassign: (customerKey: string) => Promise<boolean>;
}

function RepresentativeCard({ representative, onAssign, onUnassign }: RepresentativeCardProps) {
  const [email, setEmail] = useState('');
  const [isPending, startTransition] = useTransition();
  const name = fullName(representative);

  const assign = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const customer = email.trim();
    if (customer === '') return;
    startTransition(async () => {
      if (await onAssign(customer)) setEmail('');
    });
  };

  return (
    <Card.Root size="sm">
      <Card.Body gap="3">
        <Text fontWeight="semibold">{name}</Text>
        {representative.customers.length === 0 ? (
          <Text fontSize="xs" color="fg.muted">
            No customers assigned.
          </Text>
        ) : (
          <List.Root variant="plain" gap="2">
            {representative.customers.map((customer) => (
              <List.Item
                key={customer.key}
                display="flex"
                justifyContent="space-between"
                alignItems="center"
                borderBottomWidth="1px"
                pb="2"
              >
                <Text fontSize="xs">
                  {fullName(customer)}, {customer.email}
                </Text>
                <Button
                  size="xs"
                  colorPalette="red"
                  variant="subtle"
                  onClick={() => void onUnassign(customer.key)}
                >
                  Unassign
                </Button>
              </List.Item>
            ))}
          </List.Root>
        )}
        <form onSubmit={assign}>
          <HStack>
            <Input
              size="xs"
              placeholder="Customer email"
              aria-label={`Customer email to assign to ${name}`}
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            <Button type="submit" size="xs" colorPalette="teal" loading={isPending}>
              Assign
            </Button>
          </HStack>
        </form>
      </Card.Body>
    </Card.Root>
  );
}

/** The manager persona: assigns customers to representatives and removes them. */
export function ManagerTab({ representatives, onChanged }: ManagerTabProps) {
  const [error, setError] = useState<string | null>(null);

  async function change(method: 'POST' | 'DELETE', representative: string, customer: string) {
    const path = apiPath('representative', representative, customer);
    const outcome = await callApi<unknown>(path, MANAGER_KEY, method);
    setError(outcome.ok ? null : outcome.error);
    if (outcome.ok) await onChanged();
    return outcome.ok;
  }

  return (
    <VStack gap="4" align="stretch">
      <Text fontSize="sm" color="fg.muted">
        You are Albus Dumbledore, a manager. Assigning a customer makes the representative an editor
        on the customer&apos;s account.
      </Text>
      {error === null ? null : <ErrorAlert message={error} />}
      {representatives.map((representative) => (
        <RepresentativeCard
          key={representative.key}
          representative={representative}
          onAssign={(customer) => change('POST', representative.key, customer)}
          onUnassign={(customer) => change('DELETE', representative.key, customer)}
        />
      ))}
    </VStack>
  );
}
