import { selectedNetwork } from '#/lib/networks'
import { SolanaMark } from './solana-mark'

/** The network the dashboard reads and pays on. */
export function NetworkStatus() {
  return (
    <span>
      <SolanaMark />
      {selectedNetwork().label}
    </span>
  )
}
