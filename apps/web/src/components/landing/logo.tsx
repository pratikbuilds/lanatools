import { useId } from 'react'
import { LOGO_MARKS } from './logos'
import type { LogoId } from './logos'

export function Logo({
  id,
  size,
  color,
  className = '',
}: {
  id: LogoId
  size?: number
  /** Overrides the mark's own colour, for a mark placed on a dark tile. */
  color?: string
  className?: string
}) {
  const gradientId = useId()
  const mark = LOGO_MARKS[id]
  return (
    <svg
      viewBox={mark.viewBox}
      {...(size === undefined ? {} : { width: size, height: size })}
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {id === 'solana' && (
        <defs>
          <linearGradient
            id={gradientId}
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
        </defs>
      )}
      {mark.paths.map((d) => (
        <path
          key={d}
          d={d}
          fillRule={mark.fillRule}
          fill={color ?? (id === 'solana' ? `url(#${gradientId})` : mark.color)}
        />
      ))}
    </svg>
  )
}

/** Same mark, placed inside an existing SVG coordinate space. */
export function LogoGlyph({
  id,
  x,
  y,
  size,
  color,
}: {
  id: LogoId
  x: number
  y: number
  size: number
  color?: string
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <Logo id={id} size={size} {...(color === undefined ? {} : { color })} />
    </g>
  )
}
