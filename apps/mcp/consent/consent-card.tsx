import {
  MAX_CLIENT_LIMIT_MICRO_USD,
  formatUsd,
  parseClientLimit,
} from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'
import { WalletAddressText } from '../../web/src/components/dashboard/wallet-address'
import { BrandMark } from '../../web/src/components/landing/brand'
import type { AccountName } from '../../web/src/lib/payer'
import { ToolAccess } from './permissions'

const LIMIT_HINT = `Enter an amount up to ${formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}, such as 1.00.`

/**
 * The consent request as one card: who is connecting, the tools it may use,
 * and the two answers. It holds no state, so every state can be rendered.
 */
export function ConsentCard({
  clientName,
  hasHandle,
  ready,
  signedIn,
  account,
  scopes,
  limitUsd,
  busy,
  message,
  onScopes,
  onLimitUsd,
  onSignIn,
  onSwitchAccount,
  onDecide,
}: {
  /** The name the client gave itself, once the request has loaded. */
  clientName: string | undefined
  /** False when the page was opened without a connection request. */
  hasHandle: boolean
  /** False until it is known whether the user is signed in. */
  ready: boolean
  signedIn: boolean
  account: AccountName | undefined
  scopes: readonly ToolScope[]
  limitUsd: string
  /** The answer being sent, while one is. */
  busy: 'approve' | 'deny' | undefined
  message: string
  onScopes: (scopes: ToolScope[]) => void
  onLimitUsd: (limitUsd: string) => void
  onSignIn: () => void
  onSwitchAccount: () => void
  onDecide: (decision: 'approve' | 'deny') => void
}) {
  const sending = busy !== undefined
  const pays = scopes.includes('payments:pay')
  const badLimit = pays && parseClientLimit(limitUsd) === null

  return (
    <main
      aria-labelledby="title"
      className="d-card relative z-[1] w-full max-w-[31rem]"
    >
      <header className="d-th flex h-11 items-center gap-2 border-b border-line px-5 font-mono text-[14px] font-bold text-fg sm:px-7">
        <BrandMark size={18} />
        <span>
          lanatools<span className="font-medium text-fg-3">.sh</span>
        </span>
      </header>

      <div className="px-5 pt-6 pb-5 sm:px-7">
        <h1
          id="title"
          className="font-mono text-[1.45rem] leading-tight font-semibold tracking-[-0.04em] text-balance break-words"
        >
          {clientName ? `Connect ${clientName}?` : 'Connect a client'}
        </h1>
        {clientName === undefined ? (
          hasHandle ? (
            message && (
              <p role="alert" className="mt-2 text-[13px] text-bad">
                {message}
              </p>
            )
          ) : (
            <p role="alert" className="mt-2 text-fg-2">
              Open this page from your MCP client to connect.
            </p>
          )
        ) : signedIn && account ? (
          // The account the client is connected to, where it is hard to miss.
          <div className="mt-4 flex items-start gap-3 rounded-[10px] border border-line-2 bg-surface px-3.5 py-3">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-fg font-mono text-[14px] font-bold text-panel max-sm:hidden"
            >
              {account.label[0]?.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="d-label">Signed in as</p>
              <p
                title={account.detail}
                className="mt-1 font-mono text-[15px] font-semibold break-all text-fg"
              >
                {account.wallet ? (
                  <WalletAddressText walletAddress={account.detail} compact />
                ) : (
                  account.detail
                )}
              </p>
              <button
                type="button"
                className="d-btn d-btn-sm mt-2.5 disabled:cursor-wait max-sm:h-10 max-sm:w-full"
                disabled={sending}
                onClick={onSwitchAccount}
              >
                Use another account
              </button>
            </div>
          </div>
        ) : (
          ready && (
            <p className="mt-2 text-fg-2">
              Sign in to connect it to your LanaTools account.
            </p>
          )
        )}
      </div>

      {clientName !== undefined && (
        <>
          <section
            aria-labelledby="tools"
            className="border-t border-line px-5 pt-4 pb-5 sm:px-7"
          >
            <h2 id="tools" className="mb-1.5 text-[13px] font-medium text-fg-3">
              Choose what it can use
            </h2>
            <ToolAccess
              selected={scopes}
              onChange={onScopes}
              disabled={sending}
              payLimit={
                <>
                  <label className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-fg-2">
                    Can spend up to
                    <span className="d-limit-field flex h-9 items-center gap-1 rounded-[8px] border border-line-2 bg-surface px-2.5 font-mono text-[14px] font-semibold text-fg">
                      <span aria-hidden="true" className="text-fg-3">
                        $
                      </span>
                      <input
                        className="d-limit-input w-[5.25rem] bg-transparent"
                        inputMode="decimal"
                        autoComplete="off"
                        value={limitUsd}
                        disabled={sending}
                        aria-invalid={badLimit}
                        aria-describedby={badLimit ? 'limit-hint' : undefined}
                        onChange={(event) => onLimitUsd(event.target.value)}
                      />
                    </span>
                    in total
                  </label>
                  {badLimit && (
                    <p
                      id="limit-hint"
                      role="alert"
                      className="mt-1.5 text-[12.5px] text-bad"
                    >
                      {LIMIT_HINT}
                    </p>
                  )}
                </>
              }
            />
          </section>

          <footer className="border-t border-line bg-surface px-5 py-5 sm:px-7">
            {message && (
              <p role="alert" className="mb-3 text-[13px] text-bad">
                {message}
              </p>
            )}
            <div className="flex gap-2.5">
              {ready && !signedIn ? (
                <button
                  type="button"
                  className="d-btn d-btn-primary h-11 flex-1"
                  onClick={onSignIn}
                >
                  Sign in to connect
                </button>
              ) : (
                <button
                  type="button"
                  className="d-btn d-btn-primary h-11 flex-1"
                  disabled={!ready || sending || badLimit}
                  onClick={() => onDecide('approve')}
                >
                  {busy === 'approve' ? 'Connecting…' : 'Connect'}
                </button>
              )}
              <button
                type="button"
                className="d-btn h-11"
                disabled={sending}
                onClick={() => onDecide('deny')}
              >
                {busy === 'deny' ? 'Denying…' : 'Deny'}
              </button>
            </div>
            <p className="mt-3 text-[12.5px] text-fg-3">
              The client supplied its own name, so only continue if you started
              this connection yourself. You can{' '}
              {pays ? 'change the limit or disconnect it' : 'disconnect it'} in
              your dashboard.
            </p>
          </footer>
        </>
      )}
    </main>
  )
}
