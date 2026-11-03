import { useEffect, useState } from 'react';

interface ResourceState<T> {
  identity: string | null;
  revision: number;
  data?: T;
  loading: boolean;
  error?: string;
}

/** Saved resources are read verbatim. Only selection, activity, or explicit refresh reloads them. */
export function useSourceResource<T>(
  identity: string | null,
  active: boolean,
  load: (signal: AbortSignal) => Promise<T>,
  revision = 0,
) {
  const [state, setState] = useState<ResourceState<T>>({ identity: null, revision, loading: false });

  useEffect(() => {
    if (!active || identity === null) return;
    const controller = new AbortController();
    let disposed = false;
    setState((prev) => ({ identity, revision, data: prev.identity === identity ? prev.data : undefined, loading: true }));
    void load(controller.signal).then((data) => {
      if (!disposed) setState({ identity, revision, data, loading: false });
    }).catch((error: unknown) => {
      if (disposed) return;
      setState((prev) => ({ ...prev, loading: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return () => { disposed = true; controller.abort(); };
  }, [identity, active, load, revision]);

  // Never show another selected sid's document, even while its response is still in flight.
  const selected = state.identity === identity;
  return {
    data: selected ? state.data : undefined,
    loading: active && identity !== null && (!selected || state.revision !== revision || state.loading),
    error: selected && state.revision === revision ? state.error : undefined,
  };
}
