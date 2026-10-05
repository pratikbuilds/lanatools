import { useId } from 'react'
import { LOGO_MARKS } from '../landing/logos'

const MARK = LOGO_MARKS.solana

// Specks of glitter inside the bars, scattered with a fixed pseudo-random
// spread so every render matches. Specks that land between bars are clipped.
const SPECKS = Array.from({ length: 70 }, (_, i) => ({
  x: (i * 61.8) % 101,
  y: (i * 37.3 + (i % 7) * 5) % 88,
  r: 0.7 + ((i * 13) % 5) * 0.18,
  delay: ((i * 29) % 40) / 20,
}))

/**
 * The Solana mark as a faint watermark that, while the logo itself is hovered,
 * comes alive inside its own shape: the Solana colours flow through the
 * bars like foil, specks of glitter blink and a shine sweeps across, then
 * it settles into the mark's real colours for a moment and starts again. The
 * mark never moves or changes size, and nothing is drawn outside it.
 */
export function SolanaShine({ size = 72 }: { size?: number }) {
  const id = useId()
  const fill = `${id}-fill`
  const shine = `${id}-shine`
  const clip = `${id}-clip`
  const brand = `${id}-brand`

  return (
    <svg
      viewBox="-8 -12 117 108"
      width={size * 1.16}
      height={size}
      aria-hidden="true"
      className="sol-shine overflow-visible"
    >
      <defs>
        {/* Purple to green and back, every 202 units, so it loops seamlessly. */}
        <linearGradient
          id={fill}
          x1="0"
          y1="0"
          x2="101"
          y2="0"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="0.25" stopColor="#8752F3" />
          <stop offset="0.5" stopColor="#5497D5" />
          <stop offset="0.65" stopColor="#43B4CA" />
          <stop offset="0.8" stopColor="#28E0B9" />
          <stop offset="1" stopColor="#19FB9B" />
        </linearGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* The mark's own colours, which the animation settles into. */}
        <linearGradient
          id={brand}
          x1="8.52558"
          y1="90.0973"
          x2="88.9933"
          y2="-3.01622"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.08" stopColor="#9945FF" />
          <stop offset="0.3" stopColor="#8752F3" />
          <stop offset="0.5" stopColor="#5497D5" />
          <stop offset="0.6" stopColor="#43B4CA" />
          <stop offset="0.72" stopColor="#28E0B9" />
          <stop offset="0.97" stopColor="#19FB9B" />
        </linearGradient>
        <clipPath id={clip}>
          {MARK.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
      </defs>

      <g>
        {MARK.paths.map((d) => (
          <path key={d} d={d} className="sol-shine-mute" fill="currentColor" />
        ))}
        <g className="sol-shine-colour" clipPath={`url(#${clip})`}>
          <rect
            className="sol-shine-flow"
            x="-202"
            y="-10"
            width="505"
            height="110"
            fill={`url(#${fill})`}
          />
          {SPECKS.map((speck, i) => (
            <circle
              key={i}
              className="sol-shine-speck"
              cx={speck.x}
              cy={speck.y}
              r={speck.r}
              style={{ animationDelay: `${speck.delay}s` }}
            />
          ))}
          <rect
            className="sol-shine-sweep"
            x="-60"
            y="-20"
            width="40"
            height="130"
            fill={`url(#${shine})`}
            transform="skewX(-20)"
          />
          {MARK.paths.map((d) => (
            <path
              key={d}
              d={d}
              className="sol-shine-real"
              fill={`url(#${brand})`}
            />
          ))}
        </g>
      </g>
    </svg>
  )
}
