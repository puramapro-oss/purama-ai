import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** Capture before an await; check before state, notifications, or another request.
 * The token changes on each committed lifetime, including A -> B -> A and StrictMode.
 */
export function useRequestScope(key: string): () => () => boolean {
  const current = useRef<{ key: string } | null>(null);
  useLayoutEffect(() => {
    const token = { key };
    current.current = token;
    return () => { if (current.current === token) current.current = null; };
  }, [key]);

  return useCallback(() => {
    const token = current.current;
    return () => token !== null && token.key === key && current.current === token;
  }, [key]);
}

/** Hide the old scope during render, before passive effects can load its successor.
 * The initial value is fixed for this hook instance. Async writers still need a
 * request token captured before their await to reject expired lifetimes.
 */
export function useScopedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const fallback = useRef(initial);
  const [state, setState] = useState(() => ({ key, value: initial }));
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    setState(previous => {
      const value = previous.key === key ? previous.value : fallback.current;
      return { key, value: typeof action === 'function' ? (action as (value: T) => T)(value) : action };
    });
  }, [key]);
  return [state.key === key ? state.value : fallback.current, setValue];
}
