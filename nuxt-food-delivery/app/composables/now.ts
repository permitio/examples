import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * The current time, updated every 30 seconds in the browser. It stays `null` on the server and
 * while hydrating, so relative times render only in the browser, in the viewer's time zone.
 */
export function useNow(): Ref<Date | null> {
  const now = ref<Date | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    now.value = new Date();
    timer = setInterval(() => (now.value = new Date()), 30_000);
  });
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
