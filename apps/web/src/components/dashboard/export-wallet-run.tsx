import { useExportWallet } from '@privy-io/react-auth/solana'
import { useEffect, useRef } from 'react'
import { useDashboardSession } from './session'

/** Opens Privy's key export after the settings page has asked for it. */
export function RunExport({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: () => void
}) {
  const { walletAddress } = useDashboardSession()
  const { exportWallet } = useExportWallet()
  const started = useRef(false)
  useEffect(() => {
    if (!walletAddress || started.current) return
    started.current = true
    void exportWallet({ address: walletAddress }).then(onDone, onError)
  }, [walletAddress, exportWallet, onDone, onError])
  return null
}
