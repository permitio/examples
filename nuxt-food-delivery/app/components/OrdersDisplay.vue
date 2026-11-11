<script setup lang="ts">
import type { FormSubmitEvent } from '@primevue/forms';
import { yupResolver } from '@primevue/forms/resolvers/yup';
import { computed } from 'vue';
import * as yup from 'yup';
import type { Order } from '#shared/types';
import { useAction } from '~/composables/action';
import { useNow } from '~/composables/now';
import { useOrdersStore } from '~/stores/orders';
import { formatTime } from '~/utils/time';

const orders = useOrdersStore();
const now = useNow();
const { busy, run } = useAction();
const initialRider = { rider: '' };
const resolver = yupResolver(
  yup.object().shape({
    rider: yup.string().required('Required').min(3, '3 characters or more'),
  }),
);
const expanded = computed(() => orders.all.map(({ id }) => id));

const when = (iso: string | undefined) =>
  iso === undefined || now.value === null ? '' : formatTime(iso, now.value);

const details = (order: Order) => ({
  'Order Time': when(order.orderTime),
  Customer: order.customer,
  Vendor: order.vendor,
  'Fulfilled Time': when(order.fulfilledTime),
  'Rider Assigned Time': when(order.riderAssignedTime),
  Rider: order.rider ?? '',
  'Delivered Time': when(order.deliveredTime),
});

async function assignRider(event: FormSubmitEvent, id: number) {
  if (!event.valid) return;
  const rider = String(event.values['rider']).trim();
  await run(
    `assign:${id}`,
    () => orders.assignRider(id, rider),
    (result) => result.message,
  );
}
</script>

<template>
  <Message v-if="orders.loadError" severity="warn" class="my-4">{{ orders.loadError }}</Message>
  <p v-else-if="orders.all.length === 0" class="mt-4 mb-8 text-center opacity-30">No orders yet.</p>

  <Accordion :value="expanded" multiple>
    <AccordionPanel v-for="order of orders.all" :key="order.id" :value="order.id">
      <AccordionHeader>
        <div class="mr-4 flex grow justify-between">
          <h3>Order #{{ order.id }}</h3>
          <span>{{ order.grandTotal }} 💵</span>
        </div>
      </AccordionHeader>
      <AccordionContent>
        <div class="max-w-xs">
          <div
            v-for="meal of order.meals"
            :key="meal.id"
            class="mb-1 flex items-start justify-between text-sm"
          >
            <p>
              <span>{{ meal.name }}</span>
              <span v-if="meal.quantity > 1" class="ml-1 opacity-75">(x{{ meal.quantity }})</span>
            </p>
            <span class="text-nowrap">{{ meal.price * meal.quantity }} 💵</span>
          </div>
          <p class="mb-1 flex items-start justify-between text-sm">
            <span>Total Price</span>
            <span class="text-nowrap underline">{{ order.totalPrice }} 💵</span>
          </p>
          <p class="mb-1 flex items-start justify-between text-sm">
            <span>Delivery Fee</span>
            <span class="text-nowrap">
              {{ order.deliveryFee ? `${order.deliveryFee} 💵` : 'FREE' }}
            </span>
          </p>
          <p class="mb-2 flex items-start justify-between">
            <span>Grand Total</span>
            <span class="font-bold text-nowrap underline">{{ order.grandTotal }} 💵</span>
          </p>
        </div>
        <ul class="mb-3 border-b border-gray-500/25">
          <li
            v-for="(value, key) in details(order)"
            :key="key"
            class="border border-b-0 border-gray-500/25 text-sm"
          >
            <span class="inline-block w-40 border-r border-gray-500/25 bg-gray-500/25 px-2 py-1">
              {{ key }}:
            </span>
            <span class="inline-block px-2 py-1">{{ value }}</span>
          </li>
        </ul>

        <div class="flex flex-wrap items-end justify-end gap-4">
          <Button
            v-if="!order.fulfilledTime"
            label="Fulfill"
            :loading="busy === `fulfill:${order.id}`"
            @click="
              run(
                `fulfill:${order.id}`,
                () => orders.fulfill(order.id),
                (r) => r.message,
              )
            "
          />
          <Button
            v-if="!order.deliveredTime"
            label="Deliver"
            :loading="busy === `deliver:${order.id}`"
            @click="
              run(
                `deliver:${order.id}`,
                () => orders.deliver(order.id),
                (r) => r.message,
              )
            "
          />
          <Form
            v-if="!order.riderAssignedTime"
            v-slot="$form"
            :initial-values="initialRider"
            :resolver
            class="flex items-end gap-4"
            @submit="(event: FormSubmitEvent) => assignRider(event, order.id)"
          >
            <div class="flex flex-col gap-1">
              <FloatLabel variant="in">
                <InputText :id="`rider-${order.id}`" name="rider" type="text" list="personas" />
                <label :for="`rider-${order.id}`">Rider</label>
              </FloatLabel>
              <Message
                v-if="$form['rider']?.invalid"
                severity="error"
                size="small"
                variant="simple"
              >
                {{ $form['rider'].error?.message }}
              </Message>
            </div>
            <Button
              type="submit"
              label="Assign"
              :class="$form['rider']?.invalid ? 'mb-6' : ''"
              :loading="busy === `assign:${order.id}`"
            />
          </Form>
        </div>
      </AccordionContent>
    </AccordionPanel>
  </Accordion>
</template>
