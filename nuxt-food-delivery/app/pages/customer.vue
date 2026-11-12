<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DELIVERY_FEE, FREE_DELIVERY_FROM, type Meal, type MealInOrder } from '#shared/types';
import { useAction } from '~/composables/action';
import { useCityStore } from '~/stores/city';
import { useMealsStore } from '~/stores/meals';
import { useOrdersStore } from '~/stores/orders';

const city = useCityStore();
const meals = useMealsStore();
const orders = useOrdersStore();
const { busy, run } = useAction();

const cart = ref<MealInOrder[]>([]);
const cartTotal = computed(() =>
  cart.value.reduce((sum, { price, quantity }) => sum + price * quantity, 0),
);
// A preview only: the server asks Permit whether this order gets free delivery.
const deliveryFee = computed(() => (cartTotal.value >= FREE_DELIVERY_FROM ? 0 : DELIVERY_FEE));
const grandTotal = computed(() => cartTotal.value + deliveryFee.value);

// Each city has its own menu.
watch(
  () => city.current,
  () => (cart.value = []),
);

const inCart = (meal: Meal) => cart.value.find(({ id }) => id === meal.id);

function addToCart(meal: Meal) {
  const line = inCart(meal);
  if (line) line.quantity++;
  else cart.value.push({ id: meal.id, name: meal.name, price: meal.price, quantity: 1 });
}

function removeFromCart(meal: Meal) {
  const line = inCart(meal);
  if (line === undefined) return;
  if (line.quantity > 1) line.quantity--;
  else cart.value = cart.value.filter(({ id }) => id !== meal.id);
}

async function orderNow() {
  const placed = await run(
    'order',
    () => orders.add({ meals: cart.value.map(({ id, quantity }) => ({ id, quantity })) }),
    ({ id, deliveryFee: fee }) =>
      `Order #${id} placed, delivery ${fee === 0 ? 'free' : `${fee} 💵`}. See the Orders tab.`,
  );
  if (placed) cart.value = [];
}
</script>

<template>
  <Tabs value="0">
    <TabList>
      <Tab value="0">Cart</Tab>
      <Tab value="1">Orders</Tab>
    </TabList>

    <TabPanels>
      <TabPanel value="0">
        <h3 class="my-4 text-xl">Cart</h3>
        <p v-if="cart.length === 0" class="mb-8 text-center opacity-30">Empty cart. Add meals.</p>
        <div v-else class="max-w-xs">
          <div v-for="line of cart" :key="line.id" class="mb-2 flex items-start justify-between">
            <p>
              <span>{{ line.name }}</span>
              <span v-if="line.quantity > 1" class="ml-1 text-sm opacity-75">
                (x{{ line.quantity }})
              </span>
            </p>
            <span class="text-nowrap">{{ line.price * line.quantity }} 💵</span>
          </div>
          <p class="mb-2 flex items-start justify-between">
            <span class="underline">Cart Total</span>
            <span class="text-nowrap underline">{{ cartTotal }} 💵</span>
          </p>
          <p class="mb-2 flex items-start justify-between">
            <span>Delivery Fee</span>
            <span class="text-nowrap">{{ deliveryFee ? `${deliveryFee} 💵` : 'FREE' }}</span>
          </p>
          <p class="mb-6 flex items-start justify-between">
            <span class="font-bold">Grand Total</span>
            <span class="font-bold text-nowrap underline">{{ grandTotal }} 💵</span>
          </p>
        </div>
        <p class="text-right">
          <Button
            label="Order Now"
            :disabled="cart.length === 0"
            :loading="busy === 'order'"
            @click="orderNow"
          />
        </p>
        <div class="mt-12 mb-8 h-0.5 bg-gray-500/10"></div>
        <h3 class="mb-4 text-xl">Meals</h3>
        <Message v-if="meals.loadError" severity="warn" class="mb-4">
          {{ meals.loadError }}
        </Message>
        <p v-else-if="meals.all.length === 0" class="mt-4 mb-8 text-center opacity-30">
          No meals yet.
        </p>
        <div
          v-for="meal of meals.all"
          :key="meal.id"
          class="mb-4 flex items-start rounded-lg border border-gray-500/25 px-4 py-3 md:max-w-md"
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
            icon="pi pi-plus"
            :aria-label="`Add ${meal.name}`"
            class="-mr-3 px-2 py-0! text-primary!"
            @click="addToCart(meal)"
          />
          <Button
            :disabled="inCart(meal) === undefined"
            severity="contrast"
            variant="text"
            icon="pi pi-minus"
            :aria-label="`Remove ${meal.name}`"
            class="-mr-3 px-2 py-0! text-red-500!"
            @click="removeFromCart(meal)"
          />
        </div>
      </TabPanel>

      <TabPanel value="1">
        <OrdersDisplay />
      </TabPanel>
    </TabPanels>
  </Tabs>
</template>
