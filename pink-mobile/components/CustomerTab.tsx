import { Card, HStack, Text, VStack } from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { ChangePlanDialog } from '#components/ChangePlanDialog';
import { ErrorAlert } from '#components/ErrorAlert';
import { PersonSelect } from '#components/PersonSelect';
import { PlanBadge } from '#components/PlanBadge';
import { apiPath, callApi } from '#lib/client';
import { fullName, type Customer, type Plan } from '#lib/model';

interface CustomerTabProps {
  customers: readonly Customer[];
  onPlanChanged: (customer: string, plan: Plan) => void;
}

/** The customer persona: a customer changes their own plan. */
export function CustomerTab({ customers, onPlanChanged }: CustomerTabProps) {
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The latest choice, so an answer that arrives after the user picked again is dropped.
  const latest = useRef('');
  const customer = customers.find((person) => person.key === selected);

  function select(key: string) {
    latest.current = key;
    setSelected(key);
    setError(null);
  }

  async function changePlan(key: string, plan: Plan) {
    const outcome = await callApi<{ plan: Plan }>(apiPath('plan', key, plan), key, 'POST');
    if (outcome.ok) onPlanChanged(key, outcome.data.plan);
    if (latest.current === key) setError(outcome.ok ? null : outcome.error);
  }

  return (
    <Card.Root size="sm" maxW="sm" mx="auto">
      <Card.Body gap="4">
        <Text fontSize="sm" color="fg.muted">
          Act as a customer and change your own plan.
        </Text>
        <PersonSelect
          label="Select customer"
          people={customers}
          value={selected}
          onChange={select}
        />
        {customer === undefined ? null : (
          <VStack gap="3" align="stretch">
            <Text fontSize="sm">Name: {fullName(customer)}</Text>
            <Text fontSize="sm">Email: {customer.email}</Text>
            <HStack>
              <Text fontSize="sm">Plan:</Text>
              <PlanBadge plan={customer.plan} />
            </HStack>
            <ChangePlanDialog
              customerName={fullName(customer)}
              plan={customer.plan}
              onConfirm={(plan) => changePlan(customer.key, plan)}
            />
            {error === null ? null : <ErrorAlert message={error} />}
          </VStack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
