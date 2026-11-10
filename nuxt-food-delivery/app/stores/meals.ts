import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useFetch } from '#imports';
import type { ApiMessage, Meal, NewMeal } from '#shared/types';
import { useCityStore } from '~/stores/city';
import { useUserStore } from '~/stores/user';
import { callerHeaders, errorMessage } from '~/utils/api';

/** The current city's menu, fetched again whenever the user or the city changes. */
export const useMealsStore = defineStore('meals', () => {
  const city = useCityStore();
  const user = useUserStore();
  const headers = computed(() => callerHeaders(user.current, city.current));
  const { data, error, refresh } = useFetch<Meal[]>('/meals', { headers, default: () => [] });

  const all = computed(() => data.value);
  /** Why the menu could not be loaded, for example a denied `read` in this city. */
  const loadError = computed(() =>
    error.value ? `Could not load the menu in ${city.current}: ${errorMessage(error.value)}` : null,
  );

  async function add(meal: NewMeal): Promise<{ id: string }> {
    const result = await $fetch<{ id: string }>('/meals', {
      method: 'POST',
      body: meal,
      headers: headers.value,
    });
    await refresh();
    return result;
  }

  async function remove(id: string): Promise<ApiMessage> {
    const result = await $fetch<ApiMessage>(`/meal/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers.value,
    });
    await refresh();
    return result;
  }

  return { all, loadError, add, remove };
});
