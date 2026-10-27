import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';

import {colors} from '../styles/colors.stylex';
import {darkTheme, lightTheme} from '../styles/themes';

export type AppearancePreference = 'light' | 'dark' | 'system';

interface AppearanceContext {
  preference: AppearancePreference;
  setPreference: (preference: AppearancePreference) => void;
}

const storageKey = 'shop-things.appearance';
const Appearance = createContext<AppearanceContext | null>(null);
const styles = stylex.create({
  root: {
    backgroundColor: colors.pageBackground,
    color: colors.text,
    colorScheme: {default: 'light', '@media (prefers-color-scheme: dark)': 'dark'},
  },
  light: {colorScheme: 'light'},
  dark: {colorScheme: 'dark'},
});

const themeClasses = {
  system: stylex.props(styles.root).className!.split(' '),
  light: stylex.props(styles.root, lightTheme, styles.light).className!.split(' '),
  dark: stylex.props(styles.root, darkTheme, styles.dark).className!.split(' '),
};
const ownedClasses = new Set(Object.values(themeClasses).flat());

function applyAppearance(preference: AppearancePreference): void {
  document.documentElement.classList.remove(...ownedClasses);
  document.documentElement.classList.add(...themeClasses[preference]);
}

export function initializeAppearance(): AppearancePreference {
  let preference: AppearancePreference = 'system';
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      preference = stored;
    }
  } catch {}

  applyAppearance(preference);
  return preference;
}

export function AppearanceProvider({
  initialPreference,
  children,
}: {
  initialPreference: AppearancePreference;
  children: ReactNode;
}) {
  const [preference, setPreference] = useState(initialPreference);

  useLayoutEffect(() => applyAppearance(preference), [preference]);

  function selectPreference(next: AppearancePreference): void {
    setPreference(next);
    applyAppearance(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {}
  }

  return (
    <Appearance.Provider value={{preference, setPreference: selectPreference}}>
      {children}
    </Appearance.Provider>
  );
}

export function useAppearance(): AppearanceContext {
  const appearance = useContext(Appearance);
  if (!appearance) {
    throw new Error('AppearanceProvider is required.');
  }

  return appearance;
}
