import { useState, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const KEY = 'lt-theme'
const DARK = '(prefers-color-scheme: dark)'

function saved(): Theme | null {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function watchSystem(onChange: () => void) {
  const query = matchMedia(DARK)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * The dashboard's colour theme. It follows the system until the user picks
 * one, and the pick is remembered in this browser.
 */
export function useTheme() {
  const [picked, setPicked] = useState(saved)
  const systemDark = useSyncExternalStore(
    watchSystem,
    () => matchMedia(DARK).matches,
    () => false,
  )
  const theme: Theme = picked ?? (systemDark ? 'dark' : 'light')

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setPicked(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Not remembered, but still applied for this visit.
    }
  }
  return { theme, toggle }
}

export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: Theme
  onToggle: () => void
}) {
  const dark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="grid size-[30px] place-items-center rounded-full border-[1.5px] border-transparent text-[15px] text-hdr-dim hover:border-hdr-dim/50 hover:text-paper focus-visible:outline-lime sm:size-[34px]"
    >
      {dark ? '☀' : '☾'}
    </button>
  )
}
