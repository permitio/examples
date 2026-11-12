<script setup lang="ts">
import { useConfirm } from 'primevue/useconfirm';
import { ref } from 'vue';
import { CITIES, EXPERIENCED_RIDER_RIDES, ROLES, type Role } from '#shared/types';
import { useAction } from '~/composables/action';
import { useCityStore } from '~/stores/city';
import { useUserStore } from '~/stores/user';

const city = useCityStore();
const user = useUserStore();
const confirm = useConfirm();
const { busy, run } = useAction();
const isModalVisible = ref(false);
const currentRole = ref<Role>('customer');
const noOfRides = ref<number | null>(EXPERIENCED_RIDER_RIDES);

/** Switches user when the field is left or Enter is pressed, not on every keystroke. */
function switchUser(event: Event) {
  const value = (event.target as HTMLInputElement).value.trim();
  if (value !== '') user.current = value;
}

async function update(isGrant: boolean) {
  const done = await run(
    isGrant ? 'grant' : 'revoke',
    () =>
      user.updateRole({
        role: currentRole.value,
        user: user.current,
        tenant: city.current,
        isGrant,
        ...(currentRole.value === 'rider' ? { noOfRides: noOfRides.value ?? 0 } : {}),
      }),
    (result) => result.message,
  );
  if (done) isModalVisible.value = false;
}

function removeUser() {
  confirm.require({
    group: 'remove-user',
    message:
      `This removes the user ${user.current} from Permit, with all their roles, attributes and ` +
      'relationships. Do you want to go on?',
    header: 'Heads up!',
    rejectProps: { label: 'Not yet', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Yes, go on', severity: 'danger' },
    accept: () =>
      run(
        'remove',
        () => user.remove(),
        (result) => result.message,
      ),
  });
}
</script>

<template>
  <div class="flex items-center gap-3">
    <span class="ml-2">{{ user.current }}</span>
    <Button
      label="Manage"
      variant="outlined"
      severity="contrast"
      class="px-1 py-0.5!"
      @click="isModalVisible = !isModalVisible"
    />
    <Button
      severity="danger"
      variant="text"
      icon="pi pi-trash"
      aria-label="Remove this user from Permit"
      :loading="busy === 'remove'"
      class="-ml-3 px-2 py-0!"
      @click="removeUser"
    />
    <ConfirmDialog group="remove-user">
      <template #message="slotProps">
        <div class="max-w-md">
          <p>{{ slotProps.message.message }}</p>
        </div>
      </template>
    </ConfirmDialog>
  </div>
  <Dialog v-model:visible="isModalVisible" modal header="Manage User" class="m-8">
    <div class="mb-6 flex flex-col">
      <label for="user-id" class="mb-1 w-24 font-bold">User ID</label>
      <InputText
        id="user-id"
        :model-value="user.current"
        class="w-48"
        list="personas"
        autofocus
        autocomplete="off"
        @change="switchUser"
      />
    </div>
    <h4 class="mb-1 font-bold">City (Tenant for Role Assignment)</h4>
    <Select v-model="city.current" :options="[...CITIES]" class="mb-6 w-40" />
    <div v-if="currentRole === 'rider'" class="mb-6 flex flex-col">
      <label for="no-of-rides" class="mb-1 font-bold">Number of rides</label>
      <InputNumber
        v-model="noOfRides"
        input-id="no-of-rides"
        :min="0"
        :use-grouping="false"
        class="w-48"
      />
    </div>
    <div class="mb-6 flex flex-wrap items-end gap-4">
      <div>
        <h4 class="mb-1 font-bold">Selected Role</h4>
        <Select v-model="currentRole" :options="[...ROLES]" class="w-40" />
      </div>
      <div class="ml-auto">
        <Button
          label="Grant"
          text
          :loading="busy === 'grant'"
          :disabled="busy === 'revoke'"
          @click="update(true)"
        />
        <Button
          label="Revoke"
          severity="danger"
          text
          :loading="busy === 'revoke'"
          :disabled="busy === 'grant'"
          @click="update(false)"
        />
      </div>
    </div>
  </Dialog>
</template>
