import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { CLIENTS, usd, whole } from './data'
import type { Client } from './data'
import { Logo } from './logo'
import type { AgentId } from './logos'
import { EASE } from './reveal'

// What an agent may do, named like the cards in the hero.
type Tool = 'read' | 'pay' | 'send'

const TOOLS: Array<{
  id: Tool
  icon: string
  title: string
  body: string
  what: string
}> = [
  {
    id: 'read',
    icon: '/icons/onchain-data.svg',
    title: 'Read data',
    body: 'balances, tokens, onchain activity',
    what: 'read · account balance',
  },
  {
    id: 'pay',
    icon: '/icons/payments.svg',
    title: 'Pay for services',
    body: '',
    what: 'pay',
  },
  {
    id: 'send',
    icon: '/icons/transactions.svg',
    title: 'Send transactions',
    body: 'prepare, sign, and send',
    what: 'send · SOL → USDC',
  },
]

type AgentState = {
  can: Array<Tool>
  spent: number
  cap: number
  revoked: boolean
}
type State = Record<AgentId, AgentState>

type Entry = {
  id: number
  time: string
  client: AgentId
  tone: 'ok' | 'deny' | 'change'
  what: string
  outcome: string
}

const COSTS = [0.25, 0.1, 0.4, 0.25, 0.15]
const MAX_ENTRIES = 6
const FEED_MS = 2600

function tools(client: Client): Array<Tool> {
  const send = client.can.includes('prepare') || client.can.includes('execute')
  return TOOLS.map((t) => t.id).filter((t) =>
    t === 'send' ? send : client.can.includes(t),
  )
}

function initial(): State {
  return Object.fromEntries(
    CLIENTS.map((c) => [
      c.id,
      { can: tools(c), spent: c.spent, cap: c.cap, revoked: false },
    ]),
  ) as State
}

// Sample calls that keep arriving while the section is on screen.
const FEED: Array<[AgentId, Tool]> = [
  ['claude', 'read'],
  ['cursor', 'pay'],
  ['codex', 'send'],
  ['others', 'pay'],
  ['grok', 'send'],
  ['cursor', 'read'],
  ['claude', 'pay'],
  ['codex', 'pay'],
]

// Illustrative history so the activity log is never empty.
const SEED: Array<Entry> = [
  {
    id: -1,
    time: '12:03:58',
    client: 'codex',
    tone: 'ok',
    what: 'send · SOL → USDC',
    outcome: '✓ confirmed',
  },
  {
    id: -2,
    time: '12:03:52',
    client: 'others',
    tone: 'deny',
    what: 'pay · $0.40',
    outcome: '✕ over limit',
  },
  {
    id: -3,
    time: '12:03:40',
    client: 'cursor',
    tone: 'ok',
    what: 'pay · $0.25',
    outcome: '✓ $18.37 left',
  },
]

function clock(seconds: number) {
  const s = 12 * 3600 + 4 * 60 + seconds
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

// What a call does for an agent in a given state. Illustrative: it follows
// the same order as the flow diagram, permissions first, then the limit.
function resolve(agent: AgentState, tool: Tool, cost: number) {
  const deny = (why: string) => ({ ok: false, spent: agent.spent, why })
  if (agent.revoked) return deny('revoked')
  if (!agent.can.includes(tool)) return deny(`may not ${tool}`)
  if (tool === 'read') return { ok: true, spent: agent.spent, why: 'returned' }
  if (tool === 'send') return { ok: true, spent: agent.spent, why: 'confirmed' }
  if (agent.spent + cost > agent.cap + 1e-9) return deny('over limit')
  const spent = agent.spent + cost
  return {
    ok: true,
    spent,
    why: `${usd.format(Math.max(agent.cap - spent, 0))} left`,
  }
}

function Switch({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean
  label: string
  disabled: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full border-[1.5px] border-ink transition-colors duration-200 disabled:opacity-50 ${on ? 'bg-lime' : 'bg-card'}`}
    >
      <span
        className={`absolute top-[2.5px] left-[2.5px] size-4 rounded-full bg-ink transition-transform duration-200 ${on ? 'translate-x-5' : ''}`}
      />
    </button>
  )
}

export function Playground() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '-15% 0px' })
  const reduced = useReducedMotion()
  const [state, setState] = useState<State>(initial)
  const [selected, setSelected] = useState<AgentId>('cursor')
  const [entries, setEntries] = useState<Array<Entry>>(SEED)
  const tick = useRef(0)
  const step = useRef(0)
  const latest = useRef(state)
  latest.current = state

  function log(entry: Omit<Entry, 'id' | 'time'>) {
    const n = tick.current++
    setEntries((e) =>
      [{ ...entry, id: n, time: clock(n * 7 + 11) }, ...e].slice(
        0,
        MAX_ENTRIES,
      ),
    )
  }

  function call(id: AgentId, tool: Tool) {
    const cost = COSTS[tick.current % COSTS.length] ?? 0.25
    const agent = latest.current[id]
    const result = resolve(agent, tool, cost)
    const next = { ...latest.current, [id]: { ...agent, spent: result.spent } }
    latest.current = next
    setState(next)
    const what = TOOLS.find((t) => t.id === tool)?.what ?? tool
    log({
      client: id,
      tone: result.ok ? 'ok' : 'deny',
      what: tool === 'pay' ? `pay · ${usd.format(cost)}` : what,
      outcome: `${result.ok ? '✓' : '✕'} ${result.why}`,
    })
  }

  // A change is logged, then the agent tries that tool so the effect shows.
  const followUp = useRef<ReturnType<typeof setTimeout>>(undefined)
  function update(
    change: Partial<AgentState>,
    what: string,
    outcome: string,
    tool: Tool,
  ) {
    const id = selected
    const next = {
      ...latest.current,
      [id]: { ...latest.current[id], ...change },
    }
    latest.current = next
    setState(next)
    log({ client: id, tone: 'change', what, outcome })
    clearTimeout(followUp.current)
    followUp.current = setTimeout(() => call(id, tool), 700)
  }

  useEffect(() => {
    if (!inView || reduced) return
    const timer = setInterval(() => {
      const [id, tool] = FEED[step.current++ % FEED.length] ?? FEED[0]!
      call(id, tool)
    }, FEED_MS)
    return () => clearInterval(timer)
    // `call` reads state through refs, so the feed never needs restarting.
  }, [inView, reduced])

  useEffect(() => () => clearTimeout(followUp.current), [])

  const current = state[selected]
  const client = CLIENTS.find((c) => c.id === selected)
  const ratio = Math.min(current.spent / current.cap, 1)
  const full = ratio >= 1 - 1e-9

  return (
    <div
      ref={ref}
      className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-8"
    >
      <div className="box box-lg flex flex-col overflow-hidden">
        <div
          role="group"
          aria-label="Pick an agent"
          className="grid grid-cols-5 border-b-[1.5px] border-ink bg-paper"
        >
          {CLIENTS.map((c) => {
            const on = c.id === selected
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                aria-label={c.name}
                onClick={() => setSelected(c.id)}
                className={`flex items-center justify-center gap-2 border-rule px-2 py-3 text-[12.5px] font-bold transition-colors not-last:border-r ${
                  on ? 'bg-lime' : 'text-mute hover:bg-card hover:text-ink'
                } ${state[c.id].revoked ? 'line-through decoration-coral-ink decoration-2' : ''}`}
              >
                <Logo id={c.id} size={15} />
                <span className="hidden sm:inline">
                  {c.id === 'others' ? 'Others' : c.name}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-1">
          <p className="text-[15px] font-bold">
            {client?.name} <span className="font-medium text-mute">may</span>
          </p>
          <span
            className={`chip h-5 text-[10.5px] ${current.revoked ? 'chip-coral' : ''}`}
          >
            {current.revoked ? 'revoked' : client?.kind}
          </span>
        </div>

        <ul className={current.revoked ? 'opacity-50' : ''}>
          {TOOLS.map((t) => {
            const on = current.can.includes(t.id)
            return (
              <li
                key={t.id}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-rule px-4 py-3.5"
              >
                <span
                  className={`flex size-9 items-center justify-center rounded-[7px] border-[1.5px] border-ink transition-colors duration-200 ${on ? 'bg-lime' : 'bg-card'}`}
                >
                  <img src={t.icon} alt="" width={18} height={18} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[14.5px] leading-snug font-bold">
                    {t.title}
                  </span>
                  {t.id === 'pay' ? (
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mute">
                      <span className={full ? 'font-bold text-coral-ink' : ''}>
                        {usd.format(current.spent)} of
                      </span>
                      <span className="inline-flex items-center overflow-hidden rounded-[5px] border border-ink bg-card font-semibold text-ink">
                        <button
                          type="button"
                          aria-label="Lower limit"
                          className="h-[22px] w-6 hover:bg-paper disabled:opacity-40"
                          disabled={current.cap <= 5 || current.revoked}
                          onClick={() => {
                            update(
                              { cap: current.cap - 5 },
                              'limit lowered',
                              `→ ${whole.format(current.cap - 5)}`,
                              'pay',
                            )
                          }}
                        >
                          −
                        </button>
                        <span className="border-x border-rule px-1.5 leading-[22px]">
                          {whole.format(current.cap)}
                        </span>
                        <button
                          type="button"
                          aria-label="Raise limit"
                          className="h-[22px] w-6 hover:bg-paper disabled:opacity-40"
                          disabled={current.cap >= 50 || current.revoked}
                          onClick={() => {
                            update(
                              { cap: current.cap + 5 },
                              'limit raised',
                              `→ ${whole.format(current.cap + 5)}`,
                              'pay',
                            )
                          }}
                        >
                          +
                        </button>
                      </span>
                      <span
                        aria-hidden="true"
                        className="h-2 w-24 overflow-hidden rounded-[3px] border border-ink bg-card"
                      >
                        <span
                          className={`block h-full transition-[width] duration-500 ${full ? 'bg-coral' : 'bg-blue'}`}
                          style={{ width: `${Math.max(ratio * 100, 3)}%` }}
                        />
                      </span>
                    </span>
                  ) : (
                    <span className="block text-[12px] text-mute">
                      {t.body}
                    </span>
                  )}
                </span>
                <Switch
                  on={on}
                  label={`${client?.name} may ${t.title.toLowerCase()}`}
                  disabled={current.revoked}
                  onChange={() => {
                    update(
                      {
                        can: on
                          ? current.can.filter((x) => x !== t.id)
                          : [...current.can, t.id],
                      },
                      `${t.id} switched ${on ? 'off' : 'on'}`,
                      'from next call',
                      t.id,
                    )
                  }}
                />
              </li>
            )
          })}
        </ul>

        <div className="mt-auto flex items-center justify-between gap-3 bg-paper px-4 py-3">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              update(
                { revoked: !current.revoked },
                current.revoked ? 'restored' : 'revoked',
                current.revoked ? 'can call again' : 'calls stop',
                'read',
              )
            }}
          >
            {current.revoked ? 'Restore' : 'Revoke'} {client?.name}
          </button>
          <button
            type="button"
            className="-mr-2 h-[30px] px-2 text-[12px] font-semibold text-mute underline-offset-2 hover:text-ink hover:underline"
            onClick={() => {
              const fresh = initial()
              latest.current = fresh
              setState(fresh)
              setEntries(SEED)
            }}
          >
            reset
          </button>
        </div>
      </div>

      <div className="box box-lg flex flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b-[1.5px] border-ink bg-paper px-4 py-2.5 text-[12px]">
          <span className="font-semibold">activity log</span>
          <span className="text-mute">calls and your changes</span>
        </div>
        <ul
          className="h-[15.5rem] space-y-1.5 overflow-hidden px-3 py-3 text-[12px]"
          aria-live="off"
        >
          <AnimatePresence initial={false}>
            {entries.map((e) => {
              const name = CLIENTS.find((c) => c.id === e.client)?.name ?? ''
              return (
                <motion.li
                  key={e.id}
                  layout
                  initial={{ opacity: 0, y: -14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className={`grid grid-cols-[4.2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[5px] border px-2.5 py-1.5 ${
                    e.tone === 'deny'
                      ? 'border-ink bg-coral/25'
                      : e.tone === 'change'
                        ? 'border-ink bg-lime/40'
                        : 'border-rule bg-card'
                  }`}
                >
                  <span className="text-mute">{e.time}</span>
                  <span className="truncate">
                    <span className="font-bold">{name}</span>{' '}
                    <span className="text-mute">{e.what}</span>
                  </span>
                  <span className="font-bold">{e.outcome}</span>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
        <p className="mt-auto border-t border-rule px-4 py-2.5 text-[11.5px] text-mute">
          Changes take effect on the next call.
        </p>
      </div>
    </div>
  )
}
