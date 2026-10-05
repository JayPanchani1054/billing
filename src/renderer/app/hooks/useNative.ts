import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeAction, NativeActions } from '../../../shared/bridge.ts';
import { native } from '../bridge.ts';
import { ApiError } from '../lib/apiErrors.ts';

export interface NativeCall<A extends NativeAction> {
  run: (payload: NativeActions[A]['in']) => Promise<NativeActions[A]['out']>;
  pending: boolean;
  error: ApiError | null;
}

/**
 * A native action with pending/error state:
 *   const choose = useNative('dialog.chooseFolder');
 *   const picked = await choose.run({ title: 'Choose a folder' });   // null when cancelled
 */
export function useNative<A extends NativeAction>(action: A): NativeCall<A> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (payload: NativeActions[A]['in']): Promise<NativeActions[A]['out']> => {
      setPending(true);
      setError(null);
      try {
        return await native(action, payload);
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError('IPC_FAILED', 'The app could not complete the request.', undefined, action);
        if (mounted.current) setError(e);
        throw e;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [action],
  );

  return useMemo(() => ({ run, pending, error }), [run, pending, error]);
}
