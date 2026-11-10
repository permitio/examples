<script setup lang="ts">
import { PERSONAS } from '#shared/demo';
import { useDrawerStore } from '~/stores/drawer';

const drawer = useDrawerStore();
</script>

<template>
  <header class="flex justify-between p-4 shadow-md sm:px-8 md:hidden">
    <h1 class="text-2xl">Food Delivery</h1>
    <Button
      severity="contrast"
      variant="text"
      icon="pi pi-align-justify"
      aria-label="Menu"
      @click="drawer.open"
    />
  </header>

  <Drawer
    v-model:visible="drawer.isVisible"
    header=" "
    position="right"
    :block-scroll="true"
    class="md:hidden"
  >
    <AppMenu />
  </Drawer>

  <div class="fixed top-0 bottom-0 w-64 p-4 shadow-sm max-md:hidden dark:shadow-white/40">
    <h1 class="mb-4 text-3xl">Food Delivery</h1>
    <AppMenu />
  </div>

  <main class="p-4 sm:px-8 md:ml-64 md:max-w-2xl">
    <slot />
    <Toast />
  </main>

  <!-- Suggestions for the user and rider fields: the users the setup script creates. -->
  <datalist id="personas">
    <option v-for="persona of PERSONAS" :key="persona.key" :value="persona.key">
      {{ persona.description }}
    </option>
  </datalist>
</template>
