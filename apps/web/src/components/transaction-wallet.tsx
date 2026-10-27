import {
  SOLANA_NETWORKS,
  readSolanaNetwork,
} from '@lanatools/contracts/networks'
import type { NetworkId } from '@lanatools/contracts/networks'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from '@solana/wallet-adapter-react'
import {
  WalletAdapterNetwork,
  WalletReadyState,
} from '@solana/wallet-adapter-base'
import type { Adapter, WalletName } from '@solana/wallet-adapter-base'
import { Modal } from './dashboard/modal'

export function TransactionWalletProvider({
  children,
  network,
}: {
  children: ReactNode
  network: NetworkId | undefined
}) {
  const selected =
    SOLANA_NETWORKS[
      network ??
        readSolanaNetwork({ SOLANA_NETWORK: import.meta.env.SOLANA_NETWORK })
    ]
  const [wallets, setWallets] = useState<Adapter[]>([])
  useEffect(() => {
    let live = true
    const adapterNetwork = WalletAdapterNetwork[selected.walletAdapterNetwork]
    void Promise.all([
      import('@solana/wallet-adapter-phantom'),
      import('@solana/wallet-adapter-solflare'),
    ]).then(([phantom, solflare]) => {
      if (!live) return
      setWallets([
        new phantom.PhantomWalletAdapter(),
        new solflare.SolflareWalletAdapter({ network: adapterNetwork }),
      ])
    })
    return () => {
      live = false
    }
  }, [selected.walletAdapterNetwork])
  return (
    <ConnectionProvider endpoint={selected.publicRpcUrl}>
      <WalletProvider wallets={wallets} autoConnect={false} onError={() => {}}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  )
}

export function TransactionWallet({
  disabled = false,
  primary = true,
}: {
  disabled?: boolean
  primary?: boolean
}) {
  const { wallets, wallet, publicKey, connected, connecting, select, connect } =
    useWallet()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<WalletName | null>(null)
  const requested = useRef<WalletName | null>(null)

  useEffect(() => {
    if (
      !pending ||
      wallet?.adapter.name !== pending ||
      requested.current !== pending
    )
      return
    requested.current = null
    void connect()
      .then(() => setOpen(false))
      .catch(() => {
        setError(
          'Connection was cancelled or unavailable. Try connecting again in your wallet.',
        )
      })
      .finally(() => setPending(null))
  }, [pending, wallet, connect])

  const address = connected ? publicKey?.toBase58() : undefined
  const orderedWallets = [...wallets].sort((first, second) => {
    const available = (state: WalletReadyState) =>
      state === WalletReadyState.Installed ||
      state === WalletReadyState.Loadable
    return (
      Number(available(second.readyState)) - Number(available(first.readyState))
    )
  })
  function openPicker() {
    setError(null)
    setOpen(true)
  }

  return (
    <>
      {address ? (
        <div className="tx-wallet-identity">
          <div className="flex min-w-0 items-center gap-3">
            {wallet && (
              <img
                src={wallet.adapter.icon}
                alt=""
                className="size-7 shrink-0"
              />
            )}
            <div className="min-w-0">
              <p className="tx-wallet-identity-name truncate">
                {wallet?.adapter.name}
              </p>
              <p title={address} className="tx-wallet-identity-address">
                {address.slice(0, 4)}…{address.slice(-4)}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="tx-text-button shrink-0"
            disabled={disabled || connecting}
            onClick={openPicker}
          >
            Change wallet
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={primary ? 'tx-primary' : 'tx-text-button'}
          disabled={disabled || connecting}
          onClick={openPicker}
        >
          Connect wallet
        </button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Connect your wallet"
        detail="LANATOOLS / SOLANA"
      >
        <p className="mb-5 text-[13px] text-fg-2">Choose where to sign.</p>
        <div className="tx-wallet-list">
          {orderedWallets.map(({ adapter, readyState }) => {
            const notDetected = readyState === WalletReadyState.NotDetected
            const unavailable = readyState === WalletReadyState.Unsupported
            const content = (
              <>
                <span className="flex min-w-0 items-center gap-3">
                  <img src={adapter.icon} alt="" className="size-7 shrink-0" />
                  <span className="min-w-0">
                    <span className="tx-wallet-option-name truncate">
                      {adapter.name}
                    </span>
                    <span className="tx-wallet-option-detail">
                      {notDetected
                        ? 'Not detected in this browser'
                        : unavailable
                          ? 'Unavailable in this browser'
                          : readyState === WalletReadyState.Installed
                            ? 'Available in this browser'
                            : 'Opens your wallet'}
                    </span>
                  </span>
                </span>
                <span className="tx-wallet-option-action">
                  {notDetected
                    ? 'Install'
                    : unavailable
                      ? 'Unavailable'
                      : pending === adapter.name
                        ? 'Connecting…'
                        : 'Connect'}
                </span>
              </>
            )
            const className = 'tx-wallet-option'
            return notDetected ? (
              <a
                key={adapter.name}
                className={className}
                data-install
                href={adapter.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {content}
              </a>
            ) : (
              <button
                key={adapter.name}
                type="button"
                className={className}
                disabled={unavailable || connecting || pending !== null}
                onClick={() => {
                  setError(null)
                  requested.current = adapter.name
                  setPending(adapter.name)
                  select(adapter.name)
                }}
              >
                {content}
              </button>
            )
          })}
        </div>
        <p className="mt-4 text-[11.5px] text-fg-3">
          Other installed Solana wallets appear here automatically.
        </p>
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-bad">
            {error}
          </p>
        )}
        {pending && (
          <p role="status" className="mt-4 text-[13px] text-fg-2">
            Check {pending} to finish connecting.
          </p>
        )}
        <p className="mt-5 border-t border-line pt-4 text-[11.5px] text-fg-3">
          Connect your wallet, then review and sign. Nothing is sent until you
          sign.
        </p>
      </Modal>
    </>
  )
}
