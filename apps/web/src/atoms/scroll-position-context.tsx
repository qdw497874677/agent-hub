import { createContext, useContext, type ReactNode } from 'react';
import type { createScrollPositionStore } from './scroll-position-store.ts';

type ScrollPositionStore = ReturnType<typeof createScrollPositionStore>;
const ScrollPositionContext = createContext<ScrollPositionStore | null>(null);

export function ScrollPositionProvider({ store, children }: { store: ScrollPositionStore; children: ReactNode }) {
  return <ScrollPositionContext.Provider value={store}>{children}</ScrollPositionContext.Provider>;
}

export function useScrollPositionStore() {
  return useContext(ScrollPositionContext);
}
