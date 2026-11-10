import { Container, Heading, Spinner, Tabs, Text, VStack } from '@chakra-ui/react';
import Head from 'next/head';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CustomerTab } from '#components/CustomerTab';
import { ErrorAlert } from '#components/ErrorAlert';
import { ManagerTab } from '#components/ManagerTab';
import { RepresentativeTab } from '#components/RepresentativeTab';
import { apiPath, callApi, type Outcome } from '#lib/client';
import { MANAGER_KEY, type Customer, type Plan, type Representative } from '#lib/model';

const loadRepresentatives = () => callApi<Representative[]>(apiPath('representative'), MANAGER_KEY);
const loadCustomers = () => callApi<Customer[]>(apiPath('user'), MANAGER_KEY);

/** Renders `ready` once the list has loaded, a spinner before, and the error if it failed. */
function Loaded<T>({ list, ready }: { list: Outcome<T> | null; ready: (data: T) => ReactNode }) {
  if (list === null) return <Spinner mx="auto" display="block" />;
  if (!list.ok) return <ErrorAlert title="Could not load the demo data" message={list.error} />;
  return ready(list.data);
}

/**
 * The persona switcher stands in for sign-in: each tab acts as a different user, and the API routes
 * ask Permit what that user may do. The lists start as the manager, Albus Dumbledore.
 */
export default function Home() {
  const [representatives, setRepresentatives] = useState<Outcome<Representative[]> | null>(null);
  const [customers, setCustomers] = useState<Outcome<Customer[]> | null>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([loadRepresentatives(), loadCustomers()]).then(([reps, people]) => {
      if (!current) return;
      setRepresentatives(reps);
      setCustomers(people);
    });
    return () => {
      current = false;
    };
  }, []);

  // Counts reloads, so when the manager changes assignments quickly, only the last answer shows.
  const reloads = useRef(0);
  const reloadRepresentatives = useCallback(async () => {
    reloads.current += 1;
    const reload = reloads.current;
    const answer = await loadRepresentatives();
    if (reload === reloads.current) setRepresentatives(answer);
  }, []);

  const onPlanChanged = useCallback((key: string, plan: Plan) => {
    setCustomers((previous) =>
      previous?.ok
        ? {
            ok: true,
            data: previous.data.map((customer) =>
              customer.key === key ? { ...customer, plan } : customer,
            ),
          }
        : previous,
    );
  }, []);

  return (
    <>
      <Head>
        <title>Pink Mobile</title>
      </Head>
      <Container maxW="2xl" py="12">
        <VStack gap="2" mb="6">
          <Heading size="2xl" color="pink.500">
            Pink Mobile
          </Heading>
          <Text fontSize="sm" color="fg.muted" textAlign="center">
            Pick a persona. Each action asks Permit whether that persona may do it.
          </Text>
        </VStack>
        <Tabs.Root defaultValue="manager" lazyMount unmountOnExit>
          <Tabs.List justifyContent="center" mb="6">
            <Tabs.Trigger value="manager">Manager</Tabs.Trigger>
            <Tabs.Trigger value="representative">Representative</Tabs.Trigger>
            <Tabs.Trigger value="customer">Customer</Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="manager">
            <Loaded
              list={representatives}
              ready={(data) => (
                <ManagerTab representatives={data} onChanged={reloadRepresentatives} />
              )}
            />
          </Tabs.Content>
          <Tabs.Content value="representative">
            <Loaded
              list={representatives}
              ready={(data) => (
                <RepresentativeTab representatives={data} onPlanChanged={onPlanChanged} />
              )}
            />
          </Tabs.Content>
          <Tabs.Content value="customer">
            <Loaded
              list={customers}
              ready={(data) => <CustomerTab customers={data} onPlanChanged={onPlanChanged} />}
            />
          </Tabs.Content>
        </Tabs.Root>
      </Container>
    </>
  );
}
