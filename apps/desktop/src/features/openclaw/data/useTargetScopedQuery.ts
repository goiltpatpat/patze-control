import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpenClawPageStateKind } from '../ui/messages';

export interface TargetScopedQueryContext {
  readonly targetId: string;
  readonly signal: AbortSignal;
  readonly requestSeq: number;
}

export interface UseTargetScopedQueryOptions<TData> {
  readonly connected: boolean;
  readonly selectedTargetId: string | null;
  readonly queryFn: (context: TargetScopedQueryContext) => Promise<TData>;
  readonly isEmpty?: (data: TData) => boolean;
}

export interface TargetScopedQueryState<TData> {
  readonly targetKey: string | null;
  readonly state: OpenClawPageStateKind | 'ready';
  readonly data: TData | null;
  readonly errorMessage: string | null;
  readonly refresh: () => Promise<void>;
}

export function useTargetScopedQuery<TData>(
  options: UseTargetScopedQueryOptions<TData>
): TargetScopedQueryState<TData> {
  const { connected, selectedTargetId } = options;
  const [state, setState] = useState<OpenClawPageStateKind | 'ready'>(
    connected ? (selectedTargetId ? 'loading' : 'noTarget') : 'notReady'
  );
  const [data, setData] = useState<TData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const selectedTargetIdRef = useRef<string | null>(selectedTargetId);
  selectedTargetIdRef.current = selectedTargetId;
  const queryFnRef = useRef(options.queryFn);
  queryFnRef.current = options.queryFn;

  const isEmpty = useMemo(
    () =>
      options.isEmpty ??
      ((value: TData) =>
        Array.isArray(value) ? value.length === 0 : value === null || value === undefined),
    [options.isEmpty]
  );
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  const refresh = useCallback(async (): Promise<void> => {
    if (!connected) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setState('notReady');
      setData(null);
      setErrorMessage(null);
      return;
    }

    const targetId = selectedTargetId;
    if (!targetId) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setState('noTarget');
      setData(null);
      setErrorMessage(null);
      return;
    }

    const requestSeq = ++requestSeqRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = controller.signal;
    setState('loading');
    setErrorMessage(null);

    try {
      const nextData = await queryFnRef.current({ targetId, signal, requestSeq });
      if (
        signal.aborted ||
        requestSeq !== requestSeqRef.current ||
        targetId !== selectedTargetIdRef.current
      ) {
        return;
      }

      setData(nextData);
      setState(isEmptyRef.current(nextData) ? 'empty' : 'ready');
    } catch (error) {
      if (
        signal.aborted ||
        requestSeq !== requestSeqRef.current ||
        targetId !== selectedTargetIdRef.current
      ) {
        return;
      }
      setData(null);
      setState('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to load target-scoped data.'
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [connected, selectedTargetId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    []
  );

  return {
    targetKey: selectedTargetId,
    state,
    data,
    errorMessage,
    refresh,
  };
}
