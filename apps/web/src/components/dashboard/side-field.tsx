import { memo, useEffect, useMemo, useState } from 'react'
import { LOGO_MARKS } from '../landing/logos'

// Generic marks for agents, Solana transactions and reading data.
const ICONS = {
  agent:
    '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="14" r=".9"/><circle cx="15" cy="14" r=".9"/>',
  spark:
    '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 17v4M17 19h4"/>',
  block:
    '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  link: '<path d="M10 14a4 4 0 0 1 0-5.6l2.4-2.4a4 4 0 0 1 5.6 5.6l-1.2 1.2"/><path d="M14 10a4 4 0 0 1 0 5.6l-2.4 2.4a4 4 0 0 1-5.6-5.6l1.2-1.2"/>',
  transfer: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
  coin: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>',
  receipt:
    '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  doc: '<path d="M7 3h7l4 4v14H7Z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  chart: '<path d="M4 20h16M6 16l4-5 3 3 5-7"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5"/>',
  shield:
    '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6Z"/><path d="M9 12l2 2 4-4"/>',
  wallet:
    '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M6 7l10-3.5 1 3.5M16 13.5h2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  sign: '<path d="M15 4l5 5-10 10H5v-5Z"/><path d="M4 21h16"/>',
  fee: '<path d="M13 3L5 14h6l-1 7 8-11h-6Z"/>',
  api: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  nodes:
    '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="9" r="2"/><circle cx="10" cy="18" r="2"/><path d="M8 6.6l8 1.8M7 8l2.3 8M16.4 10.4l-4.8 6.2"/>',
  // The USDC coin, filled rather than stroked.
  usdc: '<g transform="scale(.012)"><path class="f" d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"/><path class="f" d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"/></g>',
}
const SOL = LOGO_MARKS.solana
// The page column (.d-col); the side fields fill what is left.
type Name = keyof typeof ICONS | 'sol'
// Coins and the Solana mark turn up more often than any one icon.
const NAMES: Array<Name> = [
  ...(Object.keys(ICONS) as Array<Name>),
  'sol',
  'usdc',
  'usdc',
]
const CELL = 80

type Mark = { x: number; y: number; s: number; name: Name; acc: boolean }

/**
 * Scatters marks over one side field. Seeded, so a field looks the same on
 * every visit, and jittered with gaps, so there is no visible grid.
 */
function scatter(width: number, height: number, seed: number) {
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  const marks: Mark[] = []
  let last: Name | undefined
  for (let y = 84; y < height - 56; y += CELL) {
    for (let x = 10; x < width - 36; x += CELL) {
      if (rnd() < 0.3) continue
      let name: Name
      do name = NAMES[Math.floor(rnd() * NAMES.length)] ?? 'sol'
      while (name === last)
      last = name
      marks.push({
        x: x + rnd() * (CELL - 36),
        y: y + rnd() * (CELL - 36),
        s: name === 'usdc' ? 14 + rnd() * 4 : 20 + rnd() * 10,
        name,
        acc: rnd() < 0.12,
      })
    }
  }
  // A few dashed links between near neighbours, like a small network.
  const links: string[] = []
  for (const [i, p] of marks.entries()) {
    if (rnd() > 0.3) continue
    let best: Mark | undefined
    let distance = Infinity
    for (const [j, q] of marks.entries()) {
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (j !== i && d < distance) {
        distance = d
        best = q
      }
    }
    if (best && distance < 110)
      links.push(
        `M${(p.x + p.s / 2).toFixed(1)} ${(p.y + p.s / 2).toFixed(1)}L${(best.x + best.s / 2).toFixed(1)} ${(best.y + best.s / 2).toFixed(1)}`,
      )
  }
  return { marks, links }
}

/** The window's size, measured at most once per frame. */
function useViewport() {
  const [size, setSize] = useState<{ width: number; height: number }>()
  useEffect(() => {
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setSize((last) =>
          last?.width === innerWidth && last.height === innerHeight
            ? last
            : { width: innerWidth, height: innerHeight },
        ),
      )
    }
    measure()
    addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      removeEventListener('resize', measure)
    }
  }, [])
  return size
}

/**
 * Faint marks in the margins beside content `column` pixels wide. Nothing is
 * drawn when the margins are too narrow to hold them.
 */
export const SideField = memo(function SideField({
  column,
}: {
  column: number
}) {
  const size = useViewport()
  if (!size) return null
  const width = Math.floor((size.width - column) / 2)
  if (width < 110) return null
  return (
    <>
      <Field side="d-side-l" seed={11} width={width} height={size.height} />
      <Field side="d-side-r" seed={29} width={width} height={size.height} />
    </>
  )
})

function Field({
  side,
  seed,
  width,
  height,
}: {
  side: string
  seed: number
  width: number
  height: number
}) {
  const { marks, links } = useMemo(
    () => scatter(width, height, seed),
    [width, height, seed],
  )
  return (
    <svg
      aria-hidden="true"
      className={`d-side ${side}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {links.map((d, index) => (
        <path key={index} className="flow" d={d} />
      ))}
      {marks.map((mark, index) => {
        const k = mark.s / 24
        return mark.name === 'sol' ? (
          <path
            key={index}
            className="fill"
            transform={`translate(${mark.x.toFixed(1)} ${(mark.y + 2).toFixed(1)}) scale(${((k * 20) / 88).toFixed(3)})`}
            d={SOL.paths[0]}
          />
        ) : (
          <g
            key={index}
            className={mark.acc ? 'ic acc' : 'ic'}
            transform={`translate(${mark.x.toFixed(1)} ${mark.y.toFixed(1)}) scale(${k.toFixed(3)})`}
            // Fixed markup from ICONS above, never user content.
            dangerouslySetInnerHTML={{ __html: ICONS[mark.name] }}
          />
        )
      })}
    </svg>
  )
}
