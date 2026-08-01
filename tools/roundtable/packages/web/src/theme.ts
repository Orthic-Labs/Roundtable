import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

/** Theme lives on <html data-theme>. A tiny inline script in index.html sets it
 *  before first paint (no flash); this hook reads that, then owns toggling. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme) || 'dark',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('citadel-theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}
