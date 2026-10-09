import type {UpdateBridge, UpdateState} from '@shop-things/contract';
import {queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect} from 'react';

const initial: UpdateState = {
  revision: 0,
  phase: 'idle',
  capabilityReasons: [],
  nextActions: ['check'],
};
// Application initializes one client (and bridge) for its QueryClient lifetime.
const queryKey = ['update-state'];

export default function useUpdateState(updates: UpdateBridge | null) {
  const client = useQueryClient();
  const accept = useCallback(
    (next: UpdateState | ((previous: UpdateState) => UpdateState)) => {
      client.setQueryData<UpdateState>(queryKey, previous => {
        const value = typeof next === 'function' ? next(previous ?? initial) : next;
        return previous && value.revision < previous.revision ? previous : value;
      });
    },
    [client]
  );
  const query = useQuery(
    queryOptions({
      queryKey,
      enabled: updates !== null,
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        const result = await updates!.getState({});
        if (result.status !== 'success') {
          throw new Error('Update state could not be read.');
        }

        const previous = client.getQueryData<UpdateState>(queryKey);
        return previous && result.value.revision < previous.revision
          ? previous
          : result.value;
      },
    })
  );
  useEffect(() => updates?.onStateChanged(accept), [updates, accept]);
  return [updates ? (query.data ?? initial) : initial, accept] as const;
}
