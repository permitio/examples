<script setup lang="ts">
import { CITIES } from '#shared/types';
import { useCityStore } from '~/stores/city';
import { useDrawerStore } from '~/stores/drawer';

const city = useCityStore();
const drawer = useDrawerStore();

const links = [
  { to: '/customer', icon: 'pi-shopping-cart', label: 'Customer' },
  { to: '/rider', icon: 'pi-truck', label: 'Rider' },
  { to: '/vendor', icon: 'pi-warehouse', label: 'Vendor' },
  { to: '/admin', icon: 'pi-wrench', label: 'Admin' },
];
</script>

<template>
  <nav class="mb-4">
    <ul class="mt-2">
      <li v-for="link of links" :key="link.to">
        <NuxtLink
          v-ripple
          :to="link.to"
          class="p-ripple block rounded-md px-4 py-2 text-lg"
          @click="drawer.close"
        >
          <i :class="['pi', link.icon, 'mr-3']"></i>
          <span>{{ link.label }}</span>
        </NuxtLink>
      </li>
    </ul>
  </nav>
  <h4 class="mb-2 ml-2 pt-3 font-bold underline">Current User</h4>
  <UserRoleModal />
  <h4 class="mb-1 ml-2 pt-8 font-bold">Current City</h4>
  <Select v-model="city.current" :options="[...CITIES]" class="ml-2 w-40" />
</template>

<style scoped>
nav .router-link-active {
  font-weight: bold;
}
</style>
