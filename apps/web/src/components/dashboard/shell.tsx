import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AccountName } from '#/lib/payer'
import { Frame } from './frame'
import { WalletAddressText } from './wallet-address'

// Navigation holds destinations only. Wallet data lives on the pages.
const DESTINATIONS = [
  { to: '/dashboard', label: 'Wallet', exact: true },
  { to: '/dashboard/activity', label: 'Activity', exact: false },
  { to: '/dashboard/transactions', label: 'Transactions', exact: false },
  { to: '/dashboard/settings', label: 'Settings', exact: false },
] as const

export function DashboardShell({
  session,
  status,
  children,
}: {
  /** Who is signed in; left out while that is still being checked. */
  session?: {
    account: AccountName | undefined
    onSignOut: () => void
    signOutFailed: boolean
  }
  /** The status bar's cells. */
  status: { start: ReactNode; end?: ReactNode }
  children: ReactNode
}) {
  return (
    <Frame
      status={status}
      mainClassName="pt-5 pb-12 sm:pt-7"
      nav={
        <nav
          aria-label="Main"
          className="order-last flex h-11 w-full self-stretch md:order-none md:h-auto md:w-auto md:gap-1.5"
        >
          {DESTINATIONS.map(({ to, label, exact }) => (
            <Link
              key={to}
              to={to}
              // A filtered Activity page is still the Activity page.
              activeOptions={{ exact, includeSearch: false }}
              className="relative flex flex-1 items-center justify-center px-1 font-mono text-[12px] min-[390px]:px-2 min-[390px]:text-[13px] font-medium text-hdr-dim transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:scale-x-0 after:rounded-t-[3px] after:bg-paper after:transition-transform hover:text-paper focus-visible:outline-lime aria-[current=page]:font-semibold aria-[current=page]:text-paper aria-[current=page]:after:scale-x-100 md:px-3 md:after:inset-x-3"
            >
              {label}
            </Link>
          ))}
        </nav>
      }
      actions={
        session ? (
          <AccountMenu {...session} />
        ) : (
          <span
            aria-hidden="true"
            className="d-hdr-pill w-[54px] animate-pulse opacity-60 lg:w-[150px]"
          />
        )
      }
    >
      {children}
    </Frame>
  )
}

/** Who is signed in, and the way out, behind one control. */
export function AccountMenu({
  account,
  onSignOut,
  signOutFailed,
}: {
  account: AccountName | undefined
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
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={account ? `Account, ${account.detail}` : 'Account'}
        onClick={() => setOpen(!open)}
        className="d-hdr-pill pr-2 pl-1 focus-visible:outline-lime sm:pr-3"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full bg-paper text-[12px] font-bold text-ink"
        >
          {account?.label[0]?.toUpperCase() ?? '?'}
        </span>
        {account && (
          <span className="hidden max-w-[12rem] truncate lg:block">
            {account.label}
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
          className="absolute top-[42px] right-0 z-10 w-64 max-w-[calc(100vw-2rem)] rounded-[10px] border border-line bg-panel px-4 pt-3.5 pb-4 text-fg shadow-(--d-shadow)"
        >
          {account && (
            <>
              <p className="d-label">Signed in as</p>
              <p
                className={`mt-1 mb-3.5 font-semibold ${account.wallet ? 'font-mono text-[12.5px] break-all' : 'break-words'}`}
              >
                {account.wallet ? (
                  <WalletAddressText walletAddress={account.detail} />
                ) : (
                  account.detail
                )}
              </p>
            </>
          )}
          <button
            type="button"
            role="menuitem"
            className="d-btn d-btn-sm"
            onClick={onSignOut}
          >
            Sign out
          </button>
          <p role="alert" className="mt-2 text-[12.5px] text-bad empty:hidden">
            {signOutFailed ? 'Sign-out failed. Try again.' : ''}
          </p>
        </div>
      )}
    </div>
  )
}
