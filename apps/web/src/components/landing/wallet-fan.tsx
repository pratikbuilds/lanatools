import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MCP_HOST } from './copy-url'
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

type ToolCard = {
  agent: AgentId
  name: string
  tool: string
  category: string
  value: string
  detail: string
  result: string
}

// Sample tasks shown by the hero animation, not live requests.
const CARDS: Array<ToolCard> = [
  {
    agent: 'cursor',
    name: 'Cursor',
    tool: 'Payments',
    category: 'x402 · MPP',
    value: '0.25 USDC',
    detail: 'pay for a result',
    result: 'paid result + receipt',
  },
  {
    agent: 'claude',
    name: 'Claude',
    tool: 'Onchain data',
    category: 'read · explore',
    value: '12.5 SOL',
    detail: 'read onchain balances',
    result: 'account data returned',
  },
  {
    agent: 'codex',
    name: 'Codex',
    tool: 'Portfolio',
    category: 'tokens · positions',
    value: 'Holdings',
    detail: 'tokens + positions',
    result: 'portfolio returned',
  },
  {
    agent: 'grok',
    name: 'Grok bot',
    tool: 'Transactions',
    category: 'create · execute',
    value: 'Any action',
    detail: 'prepare, sign, send',
    result: 'transaction confirmed',
  },
  {
    agent: 'others',
    name: 'Other agents',
    tool: 'Analytics',
    category: 'OpenClaw · Hermes',
    value: 'Insights',
    detail: 'query onchain activity',
    result: 'analysis returned',
  },
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
  const [active, setActive] = useState<{ index: number; n: number } | null>(
    null,
  )
  const [entered, setEntered] = useState(false)
  const n = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 1200)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!inView || reduced) return
    const run = () => {
      const i = n.current++
      setActive({ index: i % CARDS.length, n: i })
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
        aria-label="A toolkit of example agent tasks: payments, onchain data, portfolios, transactions, and analytics. One MCP connection, with permissions for each action."
      >
        {CARDS.map((c, i) => {
          const pos = fan.cards[i] ?? fan.cards[2]!
          const on = active?.index === i
          const current = on ? active : null
          return (
            <motion.div
              key={c.tool}
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
              <div
                className={`flex h-full flex-col rounded-[12px] border-[1.5px] border-ink p-4 text-ink shadow-[5px_5px_0_0_var(--color-ink)] ${on ? 'bg-card' : 'bg-paper'}`}
              >
                <span className="flex items-center gap-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[7px] border-[1.5px] border-ink bg-card">
                    <Logo id={c.agent} size={18} />
                  </span>
                  <span className="text-[10px] font-semibold text-mute">
                    {c.name}
                  </span>
                </span>
                <span className="mt-3 text-[14px] leading-tight font-bold">
                  {c.tool}
                </span>
                <span className="mt-1 text-[11px] text-mute">{c.category}</span>
                <span className="mt-5 text-[20px] leading-none font-bold">
                  {c.value}
                </span>
                <span className="mt-2 text-[11px] text-mute">{c.detail}</span>
                <span className="mt-4 border-t border-dashed border-ink/30 pt-2 text-[10px] font-semibold text-mute">
                  your permissions apply
                </span>
              </div>

              <AnimatePresence>
                {current && (
                  <motion.span
                    key={current.n}
                    className="absolute -top-11 left-1/2 flex h-8 items-center gap-1.5 rounded-[6px] border-[1.5px] border-ink bg-lime px-2.5 text-[12px] font-bold whitespace-nowrap text-ink shadow-[3px_3px_0_0_var(--color-ink)]"
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
                    ✓ {c.result}
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.div>
          )
        })}

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
          <div className="mt-4 flex items-center justify-between border-t-[1.5px] border-dashed border-ink/40 pt-3 text-[12px] font-semibold">
            <span>read · pay · execute · one activity log</span>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
