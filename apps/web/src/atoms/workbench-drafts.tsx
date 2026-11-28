import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WorkbenchDraftStore } from './workbench-draft-store.ts';

const Context = createContext<WorkbenchDraftStore | null>(null);
/** Key this provider by authenticated account; never persist drafts to browser storage. */
export function WorkbenchDraftProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => new WorkbenchDraftStore());
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useWorkbenchDrafts() {
  const store = useContext(Context);
  if (!store) throw new Error('WorkbenchDraftProvider is missing');
  const drafts = useSyncExternalStore(store.subscribe, store.getTexts, store.getTexts);
  return { drafts, setDrafts: store.setTexts.bind(store), store };
}
export function useWorkbenchDraft(id: string) {
  const store = useContext(Context);
  if (!store) throw new Error('WorkbenchDraftProvider is missing');
  const entry = useSyncExternalStore(store.subscribe, () => store.getEntry(id), () => store.getEntry(id));
  return { store, entry };
}
