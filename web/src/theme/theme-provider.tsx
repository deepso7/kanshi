import type { ReactNode } from "react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type { ThemePreference } from "./preference.ts";
import {
  applyTheme,
  darkSchemeQuery,
  parsePreference,
  readStoredPreference,
  resolveTheme,
  storePreference,
  themeStorageKey,
} from "./preference.ts";
import type { ResolvedTheme } from "./themes.ts";

interface ThemeContextValue {
  /** What the user picked. */
  readonly preference: ThemePreference;
  /** What is shown: the preference with "system" resolved. */
  readonly resolved: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const subscribeSystem = (onChange: () => void) => {
  const query = matchMedia(darkSchemeQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const systemIsDark = () => matchMedia(darkSchemeQuery).matches;
const serverIsDark = () => false;

/**
 * Owns the theme preference: reads it from localStorage, follows the
 * system while it is "system", syncs across tabs and applies the resolved
 * theme to `<html>` before the browser paints.
 */
export const ThemeProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [preference, setPreference] = useState(readStoredPreference);
  const systemDark = useSyncExternalStore(
    subscribeSystem,
    systemIsDark,
    serverIsDark
  );
  const resolved = resolveTheme(preference, systemDark);

  useLayoutEffect(() => {
    applyTheme(document.documentElement, resolved);
  }, [resolved]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === themeStorageKey || event.key === null) {
        setPreference(parsePreference(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const choosePreference = useCallback((next: ThemePreference) => {
    storePreference(next);
    setPreference(next);
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference: choosePreference }),
    [preference, resolved, choosePreference]
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
};

export const useTheme = (): ThemeContextValue => {
  const value = use(ThemeContext);
  if (value === null) {
    throw new Error("useTheme needs a <ThemeProvider> above it");
  }
  return value;
};
