import { ref } from 'vue';
import { useToast } from 'primevue/usetoast';
import { errorMessage } from '~/utils/api';

/**
 * Runs a request from a button, shows its outcome as a toast, and tracks which action is running
 * (`busy` holds its name), so only that button shows a spinner.
 */
export function useAction() {
  const toast = useToast();
  const busy = ref<string | null>(null);

  async function run<T>(name: string, request: () => Promise<T>, success: (result: T) => string) {
    busy.value = name;
    try {
      const result = await request();
      toast.add({ severity: 'success', summary: success(result), life: 4000 });
      return true;
    } catch (error) {
      toast.add({
        severity: 'error',
        summary: 'Not done',
        detail: errorMessage(error),
        life: 6000,
      });
      return false;
    } finally {
      busy.value = null;
    }
  }

  return { busy, run };
}
