<script setup lang="ts">
import type { FormSubmitEvent } from '@primevue/forms';
import { yupResolver } from '@primevue/forms/resolvers/yup';
import * as yup from 'yup';
import { useAction } from '~/composables/action';
import { useMealsStore } from '~/stores/meals';

const meals = useMealsStore();
const { busy, run } = useAction();
const initialValues = { name: '', price: '' };
const resolver = yupResolver(
  yup.object().shape({
    name: yup.string().required('Required').min(3, '3 characters or more'),
    price: yup
      .number()
      .typeError('Must be a number')
      .required('Required')
      .moreThan(0, 'Must be more than zero'),
  }),
);

async function onFormSubmit(event: FormSubmitEvent) {
  if (!event.valid) return;
  const name = String(event.values['name']);
  const price = Number(event.values['price']);
  const created = await run(
    'create',
    () => meals.add({ name, price }),
    () => `${name} added to the menu`,
  );
  if (created) event.reset();
}
</script>

<template>
  <Form v-slot="$form" :initial-values="initialValues" :resolver @submit="onFormSubmit">
    <h3 class="my-4 text-xl">Create Meal</h3>
    <div class="mb-6 flex gap-4 max-[512px]:flex-col">
      <div class="flex flex-col gap-1">
        <FloatLabel variant="in">
          <InputText id="meal-name" name="name" type="text" fluid />
          <label for="meal-name">Name</label>
        </FloatLabel>
        <Message v-if="$form['name']?.invalid" severity="error" size="small" variant="simple">
          {{ $form['name'].error?.message }}
        </Message>
      </div>
      <div class="flex flex-col gap-1">
        <FloatLabel variant="in">
          <InputText id="meal-price" name="price" type="text" inputmode="decimal" fluid />
          <label for="meal-price">Price</label>
        </FloatLabel>
        <Message v-if="$form['price']?.invalid" severity="error" size="small" variant="simple">
          {{ $form['price'].error?.message }}
        </Message>
      </div>
    </div>
    <p class="text-right">
      <Button type="submit" label="Create" :loading="busy === 'create'" />
    </p>
  </Form>
  <div class="mt-12 mb-8 h-0.5 bg-gray-500/10"></div>
  <h3 class="mb-4 text-xl">Meals</h3>
  <Message v-if="meals.loadError" severity="warn" class="mb-4">{{ meals.loadError }}</Message>
  <p v-else-if="meals.all.length === 0" class="mt-4 mb-8 text-center opacity-30">
    No meals. Create some.
  </p>
  <div
    v-for="meal of meals.all"
    :key="meal.id"
    class="mb-4 flex items-start rounded-lg border border-gray-500/25 px-4 py-3"
  >
    <p class="flex grow justify-between">
      <span>
        <span class="font-bold">{{ meal.name }}</span>
        <span class="ml-2 text-sm opacity-60">by {{ meal.vendor }}</span>
      </span>
      <span class="text-nowrap">{{ meal.price }} 💵</span>
    </p>
    <div class="ml-3 w-0.5 self-stretch bg-gray-500/10"></div>
    <Button
      severity="contrast"
      variant="text"
      icon="pi pi-trash"
      :aria-label="`Delete ${meal.name}`"
      :loading="busy === `delete:${meal.id}`"
      class="-mr-3 px-2 py-0! text-red-500"
      @click="
        run(
          `delete:${meal.id}`,
          () => meals.remove(meal.id),
          (result) => result.message,
        )
      "
    />
  </div>
</template>
