/**
 * Lets Node exit while this timer is still pending, as `timer.unref()` does
 * there. Browser timers are plain numbers with nothing to unref.
 */
export function unref(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
}
