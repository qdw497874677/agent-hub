import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAccount } from '../shell/account-context.ts';
import { applyContrast, DEFAULT_DISPLAY, displayKey, parseDisplay, type DisplaySettings } from './display-settings.ts';

type Preferences = readonly [DisplaySettings, (patch: Partial<DisplaySettings>) => void];
const DisplayContext = createContext<Preferences>([DEFAULT_DISPLAY, () => {}]);

export function DisplayPreferences({ children }: { children: ReactNode }) {
  const account = useAccount();
  return <LocalPreferences key={displayKey(account?.id ?? null)} storageKey={displayKey(account?.id ?? null)}>{children}</LocalPreferences>;
}

function LocalPreferences({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const [settings, setSettings] = useState(() => {
    try { return parseDisplay(localStorage.getItem(storageKey)); }
    catch { return DEFAULT_DISPLAY; }
  });
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    if (applyContrast(settings) === 'more') root.dataset.contrast = 'more';
    else delete root.dataset.contrast;
  }, [settings]);
  useEffect(() => {
    if (!dirty) return;
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); }
    catch { /* 隐私模式下仍可在本次使用中应用。 */ }
  }, [dirty, settings, storageKey]);
  return (
    <DisplayContext.Provider value={[settings, (patch) => {
      setDirty(true);
      setSettings((current) => ({ ...current, ...patch }));
    }]}>
      {children}
    </DisplayContext.Provider>
  );
}

export const useDisplaySettings = (): Preferences => useContext(DisplayContext);
