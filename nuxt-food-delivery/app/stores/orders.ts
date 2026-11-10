import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useFetch } from '#imports';
import type { NewOrder, Order } from '#shared/types';
import { useCityStore } from '~/stores/city';
import { useUserStore } from '~/stores/user';
import { callerHeaders, errorMessage } from '~/utils/api';

/** The current city's orders, fetched again whenever the user or the city changes. */
export const useOrdersStore = defineStore('orders', () => {
  const city = useCityStore();
  const user = useUserStore();
  const headers = computed(() => callerHeaders(user.current, city.current));
  const { data, error, refresh } = useFetch<Order[]>('/orders', { headers, default: () => [] });

  const all = computed(() => data.value);
  /** Why the orders could not be loaded, for example a denied `read` in this city. */
  const loadError = computed(() => (error.value ? errorMessage(error.value) : null));

  /** Sends a request, then reloads the orders. */
  async function thenRefresh<T>(request: Promise<T>): Promise<T> {
    const result = await request;
    await refresh();
    return result;
  }
  const post = () => ({ method: 'POST', headers: headers.value }) as const;

  return {
    all,
    loadError,
    add: (order: NewOrder) => thenRefresh($fetch('/orders', { ...post(), body: order })),
    fulfill: (id: number) => thenRefresh($fetch(`/order/${id}/fulfill`, post())),
    assignRider: (id: number, rider: string) =>
      thenRefresh($fetch(`/order/${id}/assign-rider`, { ...post(), body: { rider } })),
    deliver: (id: number) => thenRefresh($fetch(`/order/${id}/deliver`, post())),
  };
});
