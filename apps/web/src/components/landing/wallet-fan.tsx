import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { MCP_HOST } from './copy-url'
import { Logo, LogoGlyph } from './logo'
import { AGENTS } from './logos'
import type { AgentId } from './logos'
import { EASE } from './reveal'

// Drawn at a fixed size, then scaled to fit its column. Narrow columns use
// a tighter fan so phones scale it down less and the card text stays legible.
const H = 470
const CARD = { w: 168, h: 236 }
const CARD_TOP = 96
const POCKET_TOP = 312

type Fan = { w: number; cards: Array<{ dx: number; dy: number; r: number }> }

// Fan positions, left to right.
const WIDE_FAN: Fan = {
  w: 560,
  cards: [
    { dx: -176, dy: 40, r: -12 },
    { dx: -92, dy: 12, r: -6 },
    { dx: 0, dy: 0, r: 0 },
    { dx: 92, dy: 12, r: 6 },
    { dx: 176, dy: 40, r: 12 },
  ],
}

const COMPACT_FAN: Fan = {
  w: 440,
  cards: [
    { dx: -118, dy: 28, r: -9 },
    { dx: -61, dy: 8, r: -4.5 },
    { dx: 0, dy: 0, r: 0 },
    { dx: 61, dy: 8, r: 4.5 },
    { dx: 118, dy: 28, r: 9 },
  ],
}

// Each card carries a small drawing of its tool. It sits still while the
// cards are fanned and runs once when the card is played.
type ArtProps = { on: boolean }

function ArtBox({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 136 60"
      width={136}
      height={60}
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="overflow-visible stroke-ink"
    >
      {children}
    </svg>
  )
}

function Coin({ y }: { y: number }) {
  return (
    <>
      <path d={`M4 ${y} v7 a24 7 0 0 0 48 0 v-7`} className="fill-card" />
      <ellipse cx={28} cy={y} rx={24} ry={7} className="fill-lime" />
    </>
  )
}

function PayArt({ on }: ArtProps) {
  return (
    <ArtBox>
      <Coin y={46} />
      <Coin y={37} />
      <Coin y={28} />
      <motion.g
        initial={false}
        animate={on ? { y: 0, opacity: 1 } : { y: -16, opacity: 0 }}
        transition={
          on
            ? { type: 'spring', stiffness: 420, damping: 13, delay: 0.3 }
            : { duration: 0.15 }
        }
      >
        <Coin y={19} />
      </motion.g>
      <path d="M62 37 H86" strokeDasharray="3 3" />
      <path d="M83 33 l4 4 -4 4" />
      <rect
        x={94}
        y={22}
        width={41}
        height={30}
        rx={5}
        className={`transition-[fill] duration-200 ${on ? 'fill-lime' : 'fill-card'}`}
        style={{ transitionDelay: on ? '650ms' : '0ms' }}
      />
      <path d="M102 31 h14 M102 37 h25 M102 43 h18" />
    </ArtBox>
  )
}

function ReadArt({ on }: ArtProps) {
  return (
    <ArtBox>
      {[0, 1, 2].map((i) => {
        const y = 3 + i * 19
        return (
          <g key={i}>
            <rect
              x={0.75}
              y={y}
              width={134.5}
              height={15}
              rx={4}
              className={`transition-[fill] duration-200 ${on || i === 0 ? 'fill-lime' : 'fill-card'}`}
              style={{ transitionDelay: on ? `${250 + i * 160}ms` : '0ms' }}
            />
            <rect
              x={5.5}
              y={y + 4}
              width={7}
              height={7}
              rx={2}
              stroke="none"
              className="fill-ink"
            />
            <path d={`M19 ${y + 7.5} H${[58, 46, 64][i]}`} />
            <path
              d={`M${[98, 106, 92][i]} ${y + 7.5} H129`}
              className="stroke-ink/40"
            />
          </g>
        )
      })}
    </ArtBox>
  )
}

const SLICES = [
  { len: 0.45, offset: 0, stroke: 'stroke-lime', fill: 'fill-lime' },
  { len: 0.3, offset: 0.45, stroke: 'stroke-blue', fill: 'fill-blue' },
  { len: 0.25, offset: 0.75, stroke: 'stroke-paper-3', fill: 'fill-paper-3' },
]

function TrackArt({ on }: ArtProps) {
  return (
    <ArtBox>
      <g transform="rotate(-90 28 30)" strokeLinecap="butt">
        <circle cx={28} cy={30} r={20} strokeWidth={15} />
        {SLICES.map((slice, i) => {
          const len = slice.len - 0.012
          return (
            <motion.circle
              key={slice.stroke}
              cx={28}
              cy={30}
              r={20}
              strokeWidth={12}
              className={slice.stroke}
              initial={false}
              animate={{
                pathLength: on ? [0, len] : len,
                pathOffset: slice.offset,
              }}
              transition={
                on
                  ? { duration: 0.45, ease: EASE, delay: 0.25 + i * 0.18 }
                  : { duration: 0 }
              }
            />
          )
        })}
      </g>
      {SLICES.map((slice, i) => (
        <g key={slice.fill}>
          <rect
            x={66}
            y={9 + i * 16}
            width={9}
            height={9}
            rx={2}
            className={slice.fill}
          />
          <path d={`M82 ${13.5 + i * 16} H${[128, 114, 121][i]}`} />
        </g>
      ))}
    </ArtBox>
  )
}

function SendArt({ on }: ArtProps) {
  return (
    <ArtBox>
      <path d="M26 30 H102" strokeDasharray="3 4" />
      <path d="M99 25 l5 5 -5 5" />
      <circle cx={12} cy={30} r={11.25} className="fill-card" />
      <LogoGlyph id="solana" x={6} y={24} size={12} />
      <rect
        x={111}
        y={18}
        width={24}
        height={24}
        rx={6}
        className={`transition-[fill] duration-200 ${on ? 'fill-lime' : 'fill-paper-3'}`}
        style={{ transitionDelay: on ? '850ms' : '0ms' }}
      />
      <path d="M118 30 l4 4 7 -8" />
      <motion.rect
        x={24}
        y={25}
        width={10}
        height={10}
        rx={2.5}
        className="fill-lime"
        initial={false}
        animate={
          on
            ? { x: [0, 8, 68, 76], opacity: [0, 1, 1, 0] }
            : { x: 0, opacity: 0 }
        }
        transition={
          on
            ? { duration: 0.6, ease: 'easeInOut', delay: 0.3 }
            : { duration: 0 }
        }
      />
    </ArtBox>
  )
}

const BARS = [16, 26, 20, 36, 30, 48]

function AnalyzeArt({ on }: ArtProps) {
  return (
    <ArtBox>
      {BARS.map((h, i) => (
        <motion.rect
          key={i}
          x={3 + i * 23}
          y={57 - h}
          width={16}
          height={h}
          rx={3}
          className={i === BARS.length - 1 ? 'fill-blue' : 'fill-lime'}
          style={{ originY: 1 }}
          initial={false}
          animate={{ scaleY: on ? [0, 1] : 1 }}
          transition={
            on
              ? { duration: 0.4, ease: EASE, delay: 0.25 + i * 0.07 }
              : { duration: 0 }
          }
        />
      ))}
      <path d="M0 57.75 H136" />
    </ArtBox>
  )
}

type ToolCard = {
  verb: string
  tool: string
  icon: string
  value: string
  detail: string
  Art: (props: ArtProps) => ReactNode
}

// One card per tool. The icon, verb, and drawing stay readable while the
// cards are fanned; the sample value shows when a card is played.
const CARDS: Array<ToolCard> = [
  {
    verb: 'pay',
    tool: 'Payments',
    icon: '/icons/payments.svg',
    value: '0.25 USDC',
    detail: 'x402 · MPP',
    Art: PayArt,
  },
  {
    verb: 'read',
    tool: 'Onchain data',
    icon: '/icons/onchain-data.svg',
    value: '12.5 SOL',
    detail: 'account balance',
    Art: ReadArt,
  },
  {
    verb: 'track',
    tool: 'Portfolio',
    icon: '/icons/portfolio.svg',
    value: '6 tokens',
    detail: 'tokens · positions',
    Art: TrackArt,
  },
  {
    verb: 'send',
    tool: 'Transactions',
    icon: '/icons/transactions.svg',
    value: 'SOL → USDC',
    detail: 'prepare · sign',
    Art: SendArt,
  },
  {
    verb: 'analyze',
    tool: 'Analytics',
    icon: '/icons/analytics.svg',
    value: '24h volume',
    detail: 'onchain activity',
    Art: AnalyzeArt,
  },
]

type Play = { agent: AgentId; card: number; ok: boolean; result: string }

// Sample calls, not live requests. Any agent can play any card; outcomes
// follow the sample permissions and limits in data.ts.
const PLAYS: Array<Play> = [
  { agent: 'cursor', card: 0, ok: true, result: 'paid · receipt saved' },
  { agent: 'claude', card: 1, ok: true, result: 'balance returned' },
  { agent: 'codex', card: 2, ok: true, result: 'portfolio returned' },
  { agent: 'others', card: 0, ok: false, result: 'denied · over limit' },
  { agent: 'grok', card: 3, ok: true, result: 'transaction confirmed' },
  { agent: 'cursor', card: 4, ok: true, result: 'analysis returned' },
]

const AGENT_NAME = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]))

const CYCLE_MS = 3300
const REST_MS = 2500

function useFit() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(WIDE_FAN.w)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = () => setWidth(el.clientWidth)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const fan = width < 480 ? COMPACT_FAN : WIDE_FAN
  return { ref, fan, scale: Math.min(1, width / fan.w) }
}

type Played = { play: Play; n: number }

export function WalletFan() {
  const { ref, fan, scale } = useFit()
  const inView = useInView(ref, { margin: '-10% 0px' })
  const reduced = useReducedMotion()
  const [active, setActive] = useState<Played | null>(null)
  // The last call stays in the toolkit's log after its card settles.
  const [logged, setLogged] = useState<Played | null>(null)
  // A card under the mouse is played on demand and pauses the sample loop.
  const [hovered, setHovered] = useState<number | null>(null)
  const [entered, setEntered] = useState(false)
  const step = useRef(0)
  const n = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 1200)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!inView) return
    const show = (play: Play) => {
      const played = { play, n: n.current++ }
      setActive(played)
      setLogged(played)
    }
    if (hovered !== null) {
      const play = PLAYS.find((p) => p.card === hovered && p.ok)
      if (play) show(play)
      return () => setActive(null)
    }
    if (reduced) return
    let timer: ReturnType<typeof setTimeout>
    const loop = () => {
      show(PLAYS[step.current++ % PLAYS.length] ?? PLAYS[0]!)
      timer = setTimeout(() => {
        setActive(null)
        timer = setTimeout(loop, CYCLE_MS - REST_MS)
      }, REST_MS)
    }
    timer = setTimeout(loop, 1400)
    return () => {
      clearTimeout(timer)
      setActive(null)
    }
  }, [inView, reduced, hovered])

  // Hover is read from where the cards rest, not from the cards themselves,
  // so a card that lifts out from under the mouse does not flicker.
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return
    const box = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - box.left) / scale
    const y = (e.clientY - box.top) / scale
    const left = (i: number) => fan.w / 2 - CARD.w / 2 + (fan.cards[i]?.dx ?? 0)
    let over: number | null = null
    if (y > CARD_TOP - 64 && y < POCKET_TOP)
      CARDS.forEach((_, i) => {
        if (x >= left(i) && x <= left(i) + CARD.w) over = i
      })
    setHovered(over)
  }

  return (
    // The box is sized in CSS so the prerendered page reserves the same height
    // as the measured one; the fans switch at 480px, matching useFit.
    <div className="@container w-full">
      <div
        ref={ref}
        className="relative aspect-[440/470] max-h-[470px] w-full @min-[480px]:aspect-[560/470]"
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: fan.w, height: H, transform: `scale(${scale})` }}
          role="img"
          aria-label="A toolkit of example agent tasks: payments, onchain data, portfolios, transactions, and analytics. One MCP connection, with permissions and one limit for each agent. Calls within an agent's permissions and limit go through; a call over its limit is denied. Every call lands in one log."
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHovered(null)}
        >
          {CARDS.map((c, i) => {
            const pos = fan.cards[i] ?? fan.cards[2]!
            const current = active?.play.card === i ? active : null
            const on = current !== null
            const denied = current?.play.ok === false
            return (
              <motion.div
                key={c.tool}
                className="absolute"
                style={{
                  width: CARD.w,
                  height: CARD.h,
                  left: fan.w / 2 - CARD.w / 2,
                  top: CARD_TOP,
                  zIndex: on ? 15 : 10 + i,
                  transformOrigin: '50% 100%',
                }}
                initial={{ x: 0, y: 190, rotate: 0 }}
                animate={{
                  x: pos.dx * (on ? 1.08 : 1),
                  y: pos.dy + (on ? -64 : 0),
                  rotate: pos.r * (on ? 0.5 : 1),
                }}
                transition={{
                  type: 'spring',
                  stiffness: 210,
                  damping: 22,
                  delay: entered ? 0 : 0.25 + i * 0.07,
                }}
              >
                <motion.div
                  className={`flex h-full flex-col rounded-[12px] border-[1.5px] border-ink p-4 text-ink shadow-[5px_5px_0_0_var(--color-ink)] ${on ? 'bg-card' : 'bg-paper'}`}
                  animate={{ x: denied ? [0, -7, 7, -5, 5, 0] : 0 }}
                  transition={{ duration: 0.4, delay: denied ? 0.3 : 0 }}
                >
                  <span className="flex items-start justify-between">
                    <span
                      className={`flex size-9 shrink-0 items-center justify-center rounded-[7px] border-[1.5px] border-ink transition-colors duration-200 ${denied ? 'bg-coral' : on ? 'bg-lime' : 'bg-card'}`}
                    >
                      <img src={c.icon} alt="" width={20} height={20} />
                    </span>
                    <AnimatePresence>
                      {current && (
                        <motion.span
                          key={current.n}
                          className="flex size-9 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink bg-card shadow-[2px_2px_0_0_var(--color-ink)]"
                          initial={{ opacity: 0, scale: 0.4, rotate: -30 }}
                          animate={{ opacity: 1, scale: 1, rotate: 0 }}
                          exit={{ opacity: 0, scale: 0.4 }}
                          transition={{
                            type: 'spring',
                            stiffness: 380,
                            damping: 18,
                            delay: 0.12,
                          }}
                        >
                          <Logo id={current.play.agent} size={17} />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <span className="mt-2.5 text-[15px] leading-none font-bold">
                    {c.verb}
                  </span>
                  <span className="mt-3.5 block">
                    <c.Art on={on && !denied} />
                  </span>
                  <span
                    className={`flex flex-col transition-opacity duration-200 ${on ? 'opacity-100 delay-150' : 'opacity-0'}`}
                  >
                    <span className="mt-3.5 text-[18px] leading-none font-bold whitespace-nowrap">
                      {c.value}
                    </span>
                    <span className="mt-1.5 text-[11px] text-mute">
                      {c.detail}
                    </span>
                  </span>
                </motion.div>

                <AnimatePresence>
                  {current && (
                    <motion.span
                      key={current.n}
                      className={`absolute -top-11 left-1/2 flex h-8 items-center gap-1.5 rounded-[6px] border-[1.5px] border-ink px-2.5 text-[12px] font-bold whitespace-nowrap text-ink shadow-[3px_3px_0_0_var(--color-ink)] ${denied ? 'bg-coral' : 'bg-lime'}`}
                      initial={{ opacity: 0, y: 12, x: '-50%', scale: 0.8 }}
                      animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
                      exit={{ opacity: 0, y: -10, x: '-50%' }}
                      transition={{
                        type: 'spring',
                        stiffness: 380,
                        damping: 20,
                        delay: 0.25,
                      }}
                    >
                      {denied ? '✕' : '✓'} {current.play.result}
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}

          <motion.div
            className="absolute inset-x-5 bottom-2 z-20 rounded-[14px] border-[1.5px] border-ink bg-lime px-6 pt-7 pb-5 text-ink shadow-[6px_6px_0_0_var(--color-ink)]"
            style={{ height: 150 }}
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <span className="absolute inset-x-5 top-3 h-[5px] rounded-full bg-ink/85" />
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-[12px] font-semibold text-ink/70">
                  one MCP connection
                </p>
                <p className="mt-1 text-[24px] leading-none font-bold tracking-tight">
                  your toolkit
                </p>
              </div>
              <span className="rounded-[6px] border-[1.5px] border-ink bg-card px-2 py-1 text-[11.5px] font-bold">
                {MCP_HOST}
              </span>
            </div>
            <div className="relative mt-4 h-[31px] overflow-hidden border-t-[1.5px] border-dashed border-ink/40 text-[12px] font-semibold whitespace-nowrap">
              <AnimatePresence initial={false}>
                <motion.div
                  key={logged ? logged.n : 'idle'}
                  className="absolute inset-x-0 top-3 flex items-center justify-between gap-3"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14 }}
                  transition={{ duration: 0.3, ease: EASE }}
                >
                  {logged ? (
                    <>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Logo id={logged.play.agent} size={13} />
                        <span className="truncate">
                          {AGENT_NAME[logged.play.agent]} ·{' '}
                          {CARDS[logged.play.card]?.verb} ·{' '}
                          {CARDS[logged.play.card]?.value}
                        </span>
                      </span>
                      <span
                        className={
                          logged.play.ok ? 'text-ink/70' : 'text-coral-ink'
                        }
                      >
                        {logged.play.ok ? 'allowed' : 'over limit'}
                      </span>
                    </>
                  ) : (
                    <span>your permissions · your limits · one log</span>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  )
}
