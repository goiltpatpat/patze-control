import { useEffect, useMemo, useState } from 'react';
import { ControlMonitorService, type ConnectParams, type MonitorState } from './control-monitor';

export interface UseControlMonitorResult {
  readonly state: MonitorState;
  readonly connect: (params: ConnectParams) => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

export function useControlMonitor(): UseControlMonitorResult {
  const service = useMemo(() => new ControlMonitorService(), []);
  const [state, setState] = useState<MonitorState>(service.getState());

  useEffect(() => {
    return service.subscribe((nextState) => {
      setState(nextState);
    });
  }, [service]);

  useEffect(() => {
    return () => {
      void service.disconnect();
    };
  }, [service]);

  return {
    state,
    connect: (params): Promise<void> => service.connect(params),
    disconnect: (): Promise<void> => service.disconnect(),
  };
}
