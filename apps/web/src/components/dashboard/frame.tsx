import type { ReactNode } from 'react'
import { Wordmark } from '../landing/brand'
import { SideField } from './side-field'
import { ThemeToggle, useTheme } from './theme'

// The page column (.d-col), in pixels.
const COLUMN = 1100

/**
 * The chrome around the dashboard and sign-in: the themed page, the header
 * bar, the side fields and the status bar along the bottom.
 */
export function Frame({
  nav,
  actions,
  status,
  mainClassName = '',
  artColumn = COLUMN,
  children,
}: {
  /** Shown beside the logo. */
  nav?: ReactNode
  /** Shown at the right of the header, after the theme switch. */
  actions?: ReactNode
  /** Cells at the start and the end of the status bar. */
  status: { start: ReactNode; end?: ReactNode }
  mainClassName?: string
  /** How wide the content is, in pixels; the art fills the margins beside it. */
  artColumn?: number
  children: ReactNode
}) {
  const { theme, toggle } = useTheme()
  return (
    <div data-theme={theme} className="dash flex min-h-dvh flex-col sm:pb-9">
      <SideField column={artColumn} />
      <header className="relative z-[2] border-b border-hdr-line bg-hdr text-paper">
        <div className="d-col flex flex-wrap items-center gap-x-3 px-4 sm:flex-nowrap sm:gap-4 sm:px-8">
          <a
            href="/"
            aria-label="lanatools home"
            className="shrink-0 py-4 font-mono"
          >
            <Wordmark size={22} />
          </a>
          {nav}
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <ThemeToggle theme={theme} onToggle={toggle} />
            {actions}
          </div>
        </div>
      </header>
      <main
        className={`d-col relative z-[1] flex-1 px-4 sm:px-8 ${mainClassName}`}
      >
        {children}
      </main>
      <footer className="d-status-bar">
        <div>{status.start}</div>
        {status.end && <div>{status.end}</div>}
      </footer>
    </div>
  )
}
