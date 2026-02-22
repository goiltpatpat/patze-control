import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const TickerContext = createContext<number>(Date.now());

export function TickerProvider(props: { readonly children: React.ReactNode }): JSX.Element {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setTick(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);

  const element = useMemo(
    () => ({ children: props.children, value: tick }),
    [props.children, tick]
  );

  return <TickerContext.Provider value={element.value}>{element.children}</TickerContext.Provider>;
}

export function useElapsedTicker(intervalMs = 1000): number {
  const contextTick = useContext(TickerContext);

  const needsCustom = intervalMs !== 1000 && intervalMs !== 0;
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    if (!needsCustom) return;
    const id = setInterval(() => {
      setTick(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [needsCustom, intervalMs]);

  if (intervalMs === 0) return Date.now();
  if (needsCustom) return tick;
  return contextTick;
}
