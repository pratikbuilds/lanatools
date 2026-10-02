import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BrandMark, Wordmark } from '#/components/landing/brand'

// Navigation holds destinations only. Wallet data lives on the pages.
const DESTINATIONS = [
  { to: '/dashboard', label: 'Wallet', exact: true },
  { to: '/dashboard/activity', label: 'Activity', exact: false },
  { to: '/dashboard/settings', label: 'Settings', exact: false },
] as const

export function DashboardShell({
  account,
  onSignOut,
  signOutFailed,
  children,
}: {
  account: string | undefined
  onSignOut: () => void
  signOutFailed: boolean
  children: ReactNode
}) {
  return (
    <div className="on-paper min-h-screen bg-paper text-[13.5px] text-ink">
      <header className="bg-blue text-paper">
        <div className="mx-auto flex h-[60px] w-full max-w-[66rem] items-center gap-3 px-4 sm:gap-7 sm:px-7">
          <a href="/" aria-label="lanatools home">
            <span className="hidden sm:block">
              <Wordmark size={24} />
            </span>
            <span className="sm:hidden">
              <BrandMark size={24} />
            </span>
          </a>
          <nav aria-label="Main" className="flex gap-1">
            {DESTINATIONS.map(({ to, label, exact }) => (
              <Link
                key={to}
                to={to}
                // A filtered Activity page is still the Activity page.
                activeOptions={{ exact, includeSearch: false }}
                className="flex h-8 items-center rounded-[6px] px-3 text-[13px] text-paper-2 hover:bg-white/10 hover:text-paper focus-visible:outline-lime aria-[current=page]:bg-paper aria-[current=page]:font-bold aria-[current=page]:text-ink"
              >
                {label}
              </Link>
            ))}
          </nav>
          <AccountMenu
            account={account}
            onSignOut={onSignOut}
            signOutFailed={signOutFailed}
          />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[66rem] px-4 pb-24 sm:px-7">
        {children}
      </main>
    </div>
  )
}

/** Who is signed in, and the way out, behind one control. */
export function AccountMenu({
  account,
  onSignOut,
  signOutFailed,
}: {
  account: string | undefined
  onSignOut: () => void
  signOutFailed: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false)
      } else if (
        event.target instanceof Node &&
        !root.current?.contains(event.target)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div ref={root} className="relative ml-auto">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={account ? `Account, ${account}` : 'Account'}
        onClick={() => setOpen(!open)}
        className="flex h-[34px] items-center gap-2 rounded-full border-[1.5px] border-paper-2/50 pr-2 pl-1 text-[12.5px] text-paper hover:border-paper focus-visible:outline-lime aria-expanded:border-paper sm:pr-3"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full bg-paper text-[12px] font-bold text-ink"
        >
          {account?.[0]?.toUpperCase() ?? '?'}
        </span>
        {account && (
          <span className="hidden max-w-[16rem] truncate sm:block">
            {account}
          </span>
        )}
        <span
          aria-hidden="true"
          className="mx-0.5 -mt-[3px] size-[6px] rotate-45 border-r-[1.5px] border-b-[1.5px] border-current"
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-[42px] right-0 z-10 min-w-64 rounded-[10px] border-[1.5px] border-ink bg-card px-4 pt-3.5 pb-4 text-ink shadow-[4px_4px_0_0_var(--color-ink)]"
        >
          {account && (
            <>
              <p className="text-[12px] text-mute">Signed in as</p>
              <p className="mb-3.5 font-bold break-words">{account}</p>
            </>
          )}
          <button
            type="button"
            role="menuitem"
            className="btn btn-flat"
            onClick={onSignOut}
          >
            Sign out
          </button>
          <p
            role="alert"
            className="mt-2 text-[12.5px] text-coral-ink empty:hidden"
          >
            {signOutFailed ? 'Sign-out failed. Try again.' : ''}
          </p>
        </div>
      )}
    </div>
  )
}
