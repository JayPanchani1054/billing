import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, noteMutation } from '../api.ts';
import type { ApiInput, ApiOutput, RouteName } from '../api.ts';
import { ApiError, fieldErrorsOf } from '../lib/apiErrors.ts';
import { invalidate } from '../queryClient.ts';

export interface UseApiMutationOptions {
  /**
   * Route prefixes to invalidate after success. Default: the route's module ('accounts.ledger.save'
   * → 'accounts'). Pass [] to invalidate nothing; extra prefixes are added to the default.
   */
  invalidates?: readonly string[];
  /** Skip the default module invalidation (only `invalidates` is used). */
  noDefaultInvalidation?: boolean;
}

export interface ApiMutation<K extends RouteName> {
  /** Run the mutation; resolves with the output, rejects with ApiError (state also updated). */
  mutate: (input: ApiInput<K>) => Promise<ApiOutput<K>>;
  pending: boolean;
  error: ApiError | null;
  /** VALIDATION issues of the last error as { path: message }. */
  fieldErrors: Record<string, string>;
  reset: () => void;
}

function toApiError(err: unknown, route: string): ApiError {
  return err instanceof ApiError ? err : new ApiError('INTERNAL', 'Something went wrong. Please try again.', undefined, route);
}

/**
 * Save/delete/etc. with pending + error state and automatic cache invalidation.
 *
 *   const save = useApiMutation('company.profile.save');
 *   try { await save.mutate(input); toast.success('Saved'); } catch { /* save.fieldErrors shown inline *\/ }
 *
 * With the warnings protocol:
 *   await withConfirmation((ack) => save.mutate({ ...input, acknowledgeWarnings: ack || undefined }));
 */
export function useApiMutation<K extends RouteName>(route: K, options: UseApiMutationOptions = {}): ApiMutation<K> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (input: ApiInput<K>): Promise<ApiOutput<K>> => {
      setPending(true);
      setError(null);
      try {
        const out = (await api(route, ...([input] as never))) as ApiOutput<K>;
        const o = optsRef.current;
        const prefixes = new Set<string>(o.invalidates ?? []);
        if (!o.noDefaultInvalidation) prefixes.add(route.split('.')[0]);
        for (const p of prefixes) invalidate(p);
        noteMutation();
        return out;
      } catch (err) {
        const e = toApiError(err, route);
        if (mounted.current) setError(e);
        throw e;
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [route],
  );

  const reset = useCallback(() => setError(null), []);

  return useMemo(() => ({ mutate, pending, error, fieldErrors: fieldErrorsOf(error), reset }), [mutate, pending, error, reset]);
}
