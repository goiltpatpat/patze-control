import { useEffect, useState } from 'react';
import { navigate, parseRouteState, type RouteState } from './routes';

function getCurrentRouteState(): RouteState {
  return parseRouteState(window.location.hash);
}

export interface UseAppRouteResult {
  readonly routeState: RouteState;
}

export function useAppRoute(): UseAppRouteResult {
  const [routeState, setRouteState] = useState<RouteState>(getCurrentRouteState);

  useEffect(() => {
    const onHashChange = (): void => {
      setRouteState(getCurrentRouteState());
    };

    window.addEventListener('hashchange', onHashChange);
    if (!window.location.hash) {
      navigate('overview');
    }

    return (): void => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  return { routeState };
}
