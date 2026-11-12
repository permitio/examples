import { Card, HStack, Text, VStack } from '@chakra-ui/react';
import { useRef, useState } from 'react';
import { ChangePlanDialog } from '#components/ChangePlanDialog';
import { ErrorAlert } from '#components/ErrorAlert';
import { PersonSelect } from '#components/PersonSelect';
import { PlanBadge } from '#components/PlanBadge';
import { apiPath, callApi, type Outcome } from '#lib/client';
import { fullName, type AccountView, type Customer, type Person, type Plan } from '#lib/model';

interface RepresentativeTabProps {
  representatives: readonly Person[];
  onPlanChanged: (customer: string, plan: Plan) => void;
}

/**
 * The representative persona: lists the customers as the chosen representative, opens one
 * customer's account, and changes their plan. Permit decides each step.
 */
export function RepresentativeTab({ representatives, onPlanChanged }: RepresentativeTabProps) {
  const [representative, setRepresentative] = useState('');
  const [customers, setCustomers] = useState<Outcome<Customer[]> | null>(null);
  const [customer, setCustomer] = useState('');
  const [account, setAccount] = useState<Outcome<AccountView> | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  // The latest choice, so an answer that arrives after the user picked again is dropped.
  const latest = useRef({ representative: '', customer: '' });

  async function selectRepresentative(key: string) {
    latest.current = { representative: key, customer: '' };
    setRepresentative(key);
    setCustomers(null);
    setCustomer('');
    setAccount(null);
    setChangeError(null);
    if (key === '') return;
    const outcome = await callApi<Customer[]>(apiPath('user'), key);
    if (latest.current.representative === key) setCustomers(outcome);
  }

  async function selectCustomer(key: string) {
    latest.current = { representative, customer: key };
    setCustomer(key);
    setAccount(null);
    setChangeError(null);
    if (key === '') return;
    const outcome = await callApi<AccountView>(apiPath('account', key), representative);
    if (latest.current.customer === key) setAccount(outcome);
  }

  async function changePlan(plan: Plan) {
    const target = { representative, customer };
    const outcome = await callApi<{ plan: Plan }>(
      apiPath('plan', target.customer, plan),
      target.representative,
      'POST',
    );
    if (outcome.ok) onPlanChanged(target.customer, outcome.data.plan);
    const current = latest.current;
    if (current.representative !== target.representative || current.customer !== target.customer) {
      return;
    }
    setChangeError(outcome.ok ? null : outcome.error);
    if (outcome.ok) setAccount({ ok: true, data: { plan: outcome.data.plan } });
  }

  const customerList = customers?.ok ? customers.data : [];
  const chosen = customerList.find((person) => person.key === customer);

  return (
    <Card.Root size="sm" maxW="sm" mx="auto">
      <Card.Body gap="4">
        <Text fontSize="sm" color="fg.muted">
          Act as a representative, then open a customer&apos;s account.
        </Text>
        <PersonSelect
          label="Select representative"
          people={representatives}
          value={representative}
          onChange={(key) => void selectRepresentative(key)}
        />
        {customers === null ? null : customers.ok ? (
          <PersonSelect
            label="Select customer"
            people={customers.data}
            value={customer}
            onChange={(key) => void selectCustomer(key)}
          />
        ) : (
          <ErrorAlert message={customers.error} />
        )}
        {account === null ? null : account.ok ? (
          <VStack gap="3" align="stretch" borderWidth="1px" borderRadius="md" p="4">
            <HStack justify="center">
              <Text fontSize="sm">Plan:</Text>
              <PlanBadge plan={account.data.plan} />
            </HStack>
            <ChangePlanDialog
              customerName={chosen === undefined ? customer : fullName(chosen)}
              plan={account.data.plan}
              onConfirm={changePlan}
            />
            {changeError === null ? null : <ErrorAlert message={changeError} />}
          </VStack>
        ) : (
          <ErrorAlert message={account.error} />
        )}
      </Card.Body>
    </Card.Root>
  );
}
