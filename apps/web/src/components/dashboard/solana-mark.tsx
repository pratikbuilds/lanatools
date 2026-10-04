import { Logo } from '../landing/logo'

/** The Solana mark, in the current colour. */
export function SolanaMark({ size = 12 }: { size?: number }) {
  return <Logo id="solana" size={size} color="currentColor" />
}
