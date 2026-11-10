import { defineStore } from 'pinia';
import { useCookie } from '#imports';
import type { City } from '#shared/types';

/** The city the app acts in: the Permit tenant every request is checked in. */
export const useCityStore = defineStore('city', () => {
  const current = useCookie<City>('food-delivery-city', {
    default: () => 'california',
    sameSite: 'lax',
  });
  return { current };
});
