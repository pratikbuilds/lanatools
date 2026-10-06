import { Logo, LogoGlyph } from '../landing/logo'

/** The Solana mark, in the current colour. */
export function SolanaMark({ size = 12 }: { size?: number }) {
  return <Logo id="solana" size={size} color="currentColor" />
}

/** The SOL token's classic coin: the Solana mark on a dark disc. */
export function SolanaCoin({
  size = 14,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`inline-block ${className}`}
    >
      <circle cx="12" cy="12" r="12" fill="#000" />
      <LogoGlyph id="solana" x={5.5} y={6.4} size={13} />
    </svg>
  )
}
