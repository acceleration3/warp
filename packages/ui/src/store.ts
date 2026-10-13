import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppSettings, AppState, TransferSettings } from '@share/core';
import { mergeSettings } from '@share/core';

import { bridge } from './bridge';

/** Subscribes to the native state snapshot. */
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    let alive = true;
    void bridge()
      .getState()
      .then((initial) => {
        if (alive) setState(initial);
      });
    const unsubscribe = bridge().onState((next) => setState(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return state;
}

export interface SettingsApi {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateTransfer: (patch: Partial<TransferSettings>) => void;
}

export function useSettings(state: AppState | null): SettingsApi {
  // A native host may send a settings blob that predates a new field, or omits
  // a whole section. Merging against the defaults keeps the UI from reading
  // through an undefined branch.
  const settings = useMemo(
    () => mergeSettings(state?.settings ?? null, state?.self.name ?? 'This device'),
    [state?.settings, state?.self.name],
  );

  const update = useCallback((patch: Partial<AppSettings>) => {
    void bridge().updateSettings(patch);
  }, []);

  const updateTransfer = useCallback(
    (patch: Partial<TransferSettings>) => {
      void bridge().updateSettings({ transfer: { ...settings.transfer, ...patch } });
    },
    [settings.transfer],
  );

  return useMemo(() => ({ settings, update, updateTransfer }), [settings, update, updateTransfer]);
}

/** Applies the user's theme choice to the document root. */
export function useTheme(theme: AppSettings['theme']): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
}

/** Tracks whether the viewport is narrow enough to collapse the sidebar. */
export function useNarrow(breakpoint = 720): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = (): void => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [breakpoint]);
  return narrow;
}

/** Persists a small value in localStorage (view mode, last folder, ...). */
export function useLocal<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(`share.${key}`);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(`share.${key}`, JSON.stringify(next));
      } catch {
        /* private mode, quota - not worth failing over */
      }
    },
    [key],
  );

  return [value, set];
}
