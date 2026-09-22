export interface QueryRun {
  signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
  cancel(): void;
}

/** One owner's current query run. Replacing or disposing it cancels its queued SQL too. */
export function createQueryScope() {
  let current: QueryRun | null = null;

  function start(onBusy: (busy: boolean) => void): QueryRun {
    current?.cancel();
    const controller = new AbortController();
    let pending = true;
    const finish = () => {
      if (!pending) return;
      pending = false;
      onBusy(false);
    };
    const run: QueryRun = {
      signal: controller.signal,
      isCurrent: () => current === run && !controller.signal.aborted,
      finish,
      cancel: () => {
        controller.abort();
        finish();
      },
    };
    current = run;
    onBusy(true);
    return run;
  }

  return { start, cancel: () => current?.cancel() };
}
