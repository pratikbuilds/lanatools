import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MCP_HOST } from './copy-url'
import { CLIENTS, usd, whole } from './data'
import { Logo } from './logo'
import type { AgentId } from './logos'
import { EASE } from './reveal'

// Drawn at a fixed size, then scaled to fit its column. Narrow columns use
// a tighter fan so phones scale it down less and the card text stays legible.
const H = 470
const CARD = { w: 168, h: 236 }

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

type Outcome = { ok: boolean; label: string }
type Event = { id: AgentId; cost: number }

// Illustrative: two calls that fit, one over the limit, one from a client
// that may not pay.
const EVENTS: Array<Event> = [
  { id: 'cursor', cost: 0.25 },
  { id: 'codex', cost: 0.1 },
  { id: 'cloud', cost: 0.4 },
  { id: 'cursor', cost: 0.4 },
  { id: 'claude', cost: 1 },
  { id: 'codex', cost: 0.25 },
]

const CYCLE_MS = 2700
const REST_MS = 1900

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

export function WalletFan() {
  const { ref, fan, scale } = useFit()
  const inView = useInView(ref, { margin: '-10% 0px' })
  const reduced = useReducedMotion()
  const [spent, setSpent] = useState<Record<string, number>>(() =>
    Object.fromEntries(CLIENTS.map((c) => [c.id, c.spent])),
  )
  const [active, setActive] = useState<{
    id: AgentId
    n: number
    outcome: Outcome
  } | null>(null)
  const [entered, setEntered] = useState(false)
  const n = useRef(0)
  const latest = useRef(spent)
  latest.current = spent

  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 1200)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!inView || reduced) return
    const run = () => {
      const i = n.current++
      const event = EVENTS[i % EVENTS.length] ?? EVENTS[0]!
      const client = CLIENTS.find((c) => c.id === event.id)
      if (!client) return
      const have = latest.current[event.id] ?? 0
      let outcome: Outcome
      if (!client.can.includes('pay'))
        outcome = { ok: false, label: 'denied · may not pay' }
      else if (have + event.cost > client.cap + 1e-9)
        outcome = { ok: false, label: 'denied · over limit' }
      else {
        outcome = { ok: true, label: `pay.sh −${usd.format(event.cost)}` }
        // Keep the loop going: reset a client before it fills up.
        const next =
          have + event.cost > client.cap * 0.9
            ? client.spent
            : have + event.cost
        setSpent((s) => ({ ...s, [event.id]: next }))
      }
      setActive({ id: event.id, n: i, outcome })
    }
    let timer: ReturnType<typeof setTimeout>
    const loop = () => {
      run()
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
  }, [inView, reduced])

  return (
    <div ref={ref} className="relative w-full" style={{ height: H * scale }}>
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: fan.w, height: H, transform: `scale(${scale})` }}
        role="img"
        aria-label="One wallet holds a card for each agent: Cursor, Claude, Codex, Grok, and a cloud agent. Each card has its own spending limit. Calls that fit are paid; calls over the limit, or from a client that may not pay, are denied."
      >
        {CLIENTS.map((c, i) => {
          const pos = fan.cards[i] ?? fan.cards[2]!
          const on = active?.id === c.id
          const value = spent[c.id] ?? 0
          const ratio = Math.min(value / c.cap, 1)
          const full = ratio >= 1 - 1e-9
          const current = on ? active : null
          const outcome = current?.outcome ?? null
          return (
            <motion.div
              key={c.id}
              className="absolute"
              style={{
                width: CARD.w,
                height: CARD.h,
                left: fan.w / 2 - CARD.w / 2,
                top: 96,
                zIndex: on ? 15 : 10 + i,
                transformOrigin: '50% 100%',
              }}
              initial={reduced ? false : { x: 0, y: 190, rotate: 0 }}
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
                animate={
                  outcome && !outcome.ok
                    ? { x: [0, -7, 7, -4, 4, 0] }
                    : { x: 0 }
                }
                transition={{ duration: 0.45, delay: 0.35 }}
                className={`flex h-full flex-col rounded-[12px] border-[1.5px] border-ink p-4 text-ink shadow-[5px_5px_0_0_var(--color-ink)] ${
                  outcome && !outcome.ok
                    ? 'bg-[#ffd9cf]'
                    : on
                      ? 'bg-card'
                      : 'bg-paper'
                }`}
              >
                <span className="flex size-9 items-center justify-center rounded-[7px] border-[1.5px] border-ink bg-card">
                  <Logo id={c.id} size={18} />
                </span>
                <span className="mt-3 text-[14px] leading-tight font-bold">
                  {c.name}
                </span>
                <span className="text-[11px] text-mute">
                  {c.can.join(' · ')}
                </span>
                <span
                  className={`mt-4 text-[22px] leading-none font-bold ${full ? 'text-coral-ink' : ''}`}
                >
                  {usd.format(value)}
                </span>
                <span className="mt-1 text-[11px] text-mute">
                  of {whole.format(c.cap)} limit
                </span>
                <span className="mt-3 block h-2 w-full overflow-hidden rounded-[3px] border border-ink bg-card">
                  <motion.span
                    className={`block h-full ${full ? 'bg-coral' : 'bg-blue'}`}
                    animate={{ width: `${Math.max(ratio * 100, 3)}%` }}
                    transition={{ duration: 0.6, ease: EASE, delay: 0.3 }}
                  />
                </span>
              </motion.div>

              <AnimatePresence>
                {current && outcome && (
                  <motion.span
                    key={current.n}
                    className={`absolute -top-11 left-1/2 flex h-8 items-center gap-1.5 rounded-[6px] border-[1.5px] border-ink px-2.5 text-[12px] font-bold whitespace-nowrap text-ink shadow-[3px_3px_0_0_var(--color-ink)] ${
                      outcome.ok ? 'bg-lime' : 'bg-coral'
                    }`}
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
                    {outcome.ok ? '✓' : '✕'} {outcome.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.div>
          )
        })}

        {/* the wallet the cards sit in */}
        <motion.div
          className="absolute inset-x-5 bottom-2 z-20 rounded-[14px] border-[1.5px] border-ink bg-lime px-6 pt-7 pb-5 text-ink shadow-[6px_6px_0_0_var(--color-ink)]"
          style={{ height: 150 }}
          initial={reduced ? false : { y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          <span className="absolute inset-x-5 top-3 h-[5px] rounded-full bg-ink/85" />
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[12px] font-semibold text-ink/70">
                one embedded wallet
              </p>
              <p className="mt-1 text-[26px] leading-none font-bold tracking-tight">
                your wallet
              </p>
            </div>
            <span className="rounded-[6px] border-[1.5px] border-ink bg-card px-2 py-1 text-[11.5px] font-bold">
              {MCP_HOST}
            </span>
          </div>
          <div className="mt-4 flex items-center justify-between border-t-[1.5px] border-dashed border-ink/40 pt-3 text-[12px] font-semibold">
            <span>5 clients · 5 limits · 1 record</span>
            <span className="text-ink/60">illustrative</span>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
