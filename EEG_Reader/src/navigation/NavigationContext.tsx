import React, { createContext, useContext, useState, useCallback } from 'react';
import { Screen } from './types';

interface NavigationContextValue {
  screen  : Screen;
  params  : Record<string, any>;
  navigate: (s: Screen, p?: Record<string, any>) => void;
  goBack  : () => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>('login');
  const [params, setParams] = useState<Record<string, any>>({});
  const [history, setHistory] = useState<{ screen: Screen; params: Record<string, any> }[]>([]);

  const navigate = useCallback((s: Screen, p: Record<string, any> = {}) => {
    setHistory(prev => [...prev, { screen, params }]);
    setScreen(s);
    setParams(p);
  }, [screen, params]);

  const goBack = useCallback(() => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setScreen(last.screen);
      setParams(last.params);
      return prev.slice(0, -1);
    });
  }, []);

  return (
    <NavigationContext.Provider value={{ screen, params, navigate, goBack }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error('useNavigation must be used inside NavigationProvider');
  return ctx;
}
