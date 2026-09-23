import { LOGO_MARKS } from './logos'
import type { LogoId } from './logos'

function boxOf(viewBox: string) {
  const [minX, minY, width, height] = viewBox.split(' ').map(Number)
  return {
    minX: minX ?? 0,
    minY: minY ?? 0,
    width: width ?? 24,
    height: height ?? 24,
  }
}

function GrokGlyph({ fill }: { fill: string }) {
  const mark = LOGO_MARKS.grok
  const box = boxOf(mark.viewBox)
  const pad = 2.4
  const inner = 24 - pad * 2
  return (
    <g
      transform={`translate(${pad} ${pad}) scale(${inner / box.width}) translate(${-box.minX} ${-box.minY})`}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} fill={fill} />
      ))}
    </g>
  )
}

export function Logo({
  id,
  size,
  className = '',
}: {
  id: LogoId
  size?: number
  className?: string
}) {
  const mark = LOGO_MARKS[id]
  if (id === 'grok') {
    return (
      <svg
        viewBox="0 0 24 24"
        {...(size === undefined ? {} : { width: size, height: size })}
        aria-hidden="true"
        className={`shrink-0 ${className}`}
      >
        <rect width="24" height="24" rx="5.5" fill="currentColor" />
        <GrokGlyph fill="var(--color-card)" />
      </svg>
    )
  }
  return (
    <svg
      viewBox={mark.viewBox}
      {...(size === undefined ? {} : { width: size, height: size })}
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} fill="currentColor" />
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
}: {
  id: LogoId
  x: number
  y: number
  size: number
}) {
  const mark = LOGO_MARKS[id]
  const box = boxOf(mark.viewBox)
  if (id === 'grok') {
    const pad = size * 0.12
    return (
      <g transform={`translate(${x} ${y})`}>
        <rect
          width={size}
          height={size}
          rx={size * 0.22}
          className="fill-ink"
        />
        <g
          transform={`translate(${pad} ${pad}) scale(${(size - pad * 2) / box.width}) translate(${-box.minX} ${-box.minY})`}
        >
          {mark.paths.map((d) => (
            <path key={d} d={d} className="fill-card" />
          ))}
        </g>
      </g>
    )
  }
  return (
    <g
      transform={`translate(${x} ${y}) scale(${size / box.width}) translate(${-box.minX} ${-box.minY})`}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} className="fill-ink" />
      ))}
    </g>
  )
}
