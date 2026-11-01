/** Client-side admission and cancellation. This is not a distributed quota. */
export interface RequestLease {
  signal: AbortSignal;
  current: () => boolean;
  finish: () => boolean;
}

export function createRequestScope() {
  const active = new Map<string, AbortController>();
  const cancel = (channel: string) => {
    const controller = active.get(channel);
    active.delete(channel);
    controller?.abort();
  };
  return {
    begin(channel: string): RequestLease | null {
      if (active.has(channel)) return null;
      const controller = new AbortController();
      active.set(channel, controller);
      return {
        signal: controller.signal,
        current: () => active.get(channel) === controller && !controller.signal.aborted,
        finish: () => {
          if (active.get(channel) !== controller) return false;
          active.delete(channel);
          return true;
        },
      };
    },
    cancel,
    invalidate() {
      const controllers = [...active.values()];
      active.clear();
      for (const controller of controllers) controller.abort();
    },
  };
}
