import { AnimatePresence, motion, useAnimationControls } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS, usd, whole } from './data'
import type { Client } from './data'
import { Logo } from './logo'
import type { AgentId } from './logos'
import { EASE } from './reveal'

type State = Record<AgentId, { spent: number; cap: number; revoked: boolean }>

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

function initial(): State {
  return Object.fromEntries(
    CLIENTS.map((c) => [c.id, { spent: c.spent, cap: c.cap, revoked: false }]),
  ) as State
}

// Illustrative history so the activity log is never empty.
const SEED: Array<Entry> = [
  {
    id: -1,
    time: '12:03:58',
    client: 'codex',
    tone: 'ok',
    what: 'Paid API $0.10',
    outcome: '✓ $10.50 left',
  },
  {
    id: -2,
    time: '12:03:52',
    client: 'others',
    tone: 'deny',
    what: 'Paid API $0.40',
    outcome: '✕ over limit',
  },
  {
    id: -3,
    time: '12:03:40',
    client: 'cursor',
    tone: 'ok',
    what: 'Paid API $0.25',
    outcome: '✓ $18.37 left',
  },
]

function clock(seconds: number) {
  const s = 12 * 3600 + 4 * 60 + seconds
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

function ClientRow({
  client,
  state,
  selected,
  onSelect,
  pulse,
}: {
  client: Client
  state: State[AgentId]
  selected: boolean
  onSelect: () => void
  pulse: { n: number; ok: boolean } | undefined
}) {
  const controls = useAnimationControls()
  const ratio = Math.min(state.spent / state.cap, 1)
  const full = ratio >= 1 - 1e-9

  useEffect(() => {
    if (!pulse) return
    void controls.start(
      pulse.ok
        ? { scale: [1, 1.012, 1], transition: { duration: 0.3 } }
        : { x: [0, -6, 6, -3, 3, 0], transition: { duration: 0.4 } },
    )
  }, [pulse, controls])

  return (
    <motion.li animate={controls}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        // A button flattens its contents for screen readers, so the name
        // carries what the row shows: spend, limit, and state.
        aria-label={`${client.name}: ${usd.format(state.spent)} spent of ${whole.format(state.cap)} limit${
          state.revoked ? ', revoked' : full ? ', limit reached' : ''
        }`}
        className={`grid w-full grid-cols-2 gap-x-3 gap-y-2 border-b border-rule px-4 py-3.5 text-left transition-colors sm:grid-cols-[minmax(0,1.9fr)_5.5rem_4rem_minmax(7rem,1fr)] sm:items-center sm:gap-4 ${
          selected ? 'bg-lime/30' : 'bg-card hover:bg-paper'
        } ${state.revoked ? 'opacity-55' : ''}`}
      >
        <span className="col-span-2 flex items-center gap-3 sm:col-span-1">
          <span
            className={`flex size-9 items-center justify-center rounded-[6px] border border-ink ${
              selected ? 'bg-lime' : 'bg-card'
            }`}
          >
            <Logo id={client.id} size={18} />
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-bold">
              {client.name}
              {state.revoked && (
                <span className="chip chip-coral ml-2 h-5 align-[2px] text-[10.5px]">
                  revoked
                </span>
              )}
            </span>
            <span className="block text-[12px] text-mute">
              {client.kind} · {client.can.join(' · ')}
            </span>
          </span>
        </span>
        <span
          className={`font-bold sm:text-right ${full ? 'text-coral-ink' : ''}`}
        >
          <span className="mr-2 text-[11px] font-semibold tracking-wide text-mute uppercase sm:hidden">
            Spent
          </span>
          <motion.span
            key={state.spent}
            initial={{ y: -6, opacity: 0.4 }}
            animate={{ y: 0, opacity: 1 }}
            className="inline-block"
          >
            {usd.format(state.spent)}
          </motion.span>
        </span>
        <span className="text-mute sm:text-right">
          <span className="mr-2 text-[11px] font-semibold tracking-wide text-mute uppercase sm:hidden">
            Limit
          </span>
          {whole.format(state.cap)}
        </span>
        <span className="col-span-2 block sm:col-span-1">
          <span
            aria-hidden="true"
            className="block h-2.5 w-full overflow-hidden rounded-[3px] border border-ink bg-card"
          >
            <motion.span
              className={`block h-full ${full ? 'bg-coral' : 'bg-blue'}`}
              initial={{ width: '0%' }}
              whileInView={{ width: `${Math.max(ratio * 100, 2)}%` }}
              animate={{ width: `${Math.max(ratio * 100, 2)}%` }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: EASE }}
            />
          </span>
          {full && (
            <span className="mt-1.5 block text-[12px] font-semibold text-coral-ink">
              limit reached · paid calls denied
            </span>
          )}
        </span>
      </button>
    </motion.li>
  )
}

export function Playground() {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<State>(initial)
  const [selected, setSelected] = useState<AgentId>('cursor')
  const [entries, setEntries] = useState<Array<Entry>>(SEED)
  const [pulses, setPulses] = useState<
    Partial<Record<AgentId, { n: number; ok: boolean }>>
  >({})
  const tick = useRef(0)
  const latest = useRef(state)
  latest.current = state

  const call = useCallback((id: AgentId) => {
    const client = CLIENTS.find((c) => c.id === id)
    if (!client) return
    const n = tick.current++
    const cost = COSTS[n % COSTS.length] ?? 0.25
    const s = latest.current[id]
    let denied: string | null = null
    if (s.revoked) denied = 'revoked'
    else if (!client.can.includes('pay')) denied = 'may not pay'
    else if (s.spent + cost > s.cap + 1e-9) denied = 'over limit'
    const spent = denied ? s.spent : s.spent + cost
    const next = { ...latest.current, [id]: { ...s, spent } }
    latest.current = next
    setState(next)
    log({
      client: id,
      tone: denied ? 'deny' : 'ok',
      what: `Paid API ${usd.format(cost)}`,
      outcome: denied
        ? `✕ ${denied}`
        : `✓ ${usd.format(Math.max(s.cap - spent, 0))} left`,
    })
    setPulses((p) => ({ ...p, [id]: { n, ok: !denied } }))
  }, [])

  function log(entry: Omit<Entry, 'id' | 'time'>) {
    const n = tick.current++
    setEntries((e) =>
      [{ ...entry, id: n, time: clock(n * 7 + 11) }, ...e].slice(
        0,
        MAX_ENTRIES,
      ),
    )
  }

  function update(
    change: Partial<State[AgentId]>,
    what: string,
    outcome: string,
  ) {
    const next = {
      ...latest.current,
      [selected]: { ...latest.current[selected], ...change },
    }
    latest.current = next
    setState(next)
    log({ client: selected, tone: 'change', what, outcome })
  }

  const current = state[selected]
  const client = CLIENTS.find((c) => c.id === selected)

  return (
    <div
      ref={ref}
      className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:gap-8"
    >
      <div className="box box-lg overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,1.9fr)_5.5rem_4rem_minmax(7rem,1fr)] gap-4 border-b border-rule bg-paper px-4 py-2 text-[11px] font-semibold tracking-wide text-mute uppercase sm:grid">
          <span>Agent</span>
          <span className="text-right">Spent</span>
          <span className="text-right">Limit</span>
          <span>Used</span>
        </div>
        <ul>
          {CLIENTS.map((c) => (
            <ClientRow
              key={c.id}
              client={c}
              state={state[c.id]}
              selected={c.id === selected}
              pulse={pulses[c.id]}
              onSelect={() => {
                setSelected(c.id)
              }}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2.5 border-t-[1.5px] border-ink bg-paper px-4 py-3">
          <span className="mr-1 flex items-center gap-2 text-[13px] font-bold">
            <Logo id={selected} size={14} />
            {client?.name}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              call(selected)
            }}
          >
            Send a paid call
          </button>
          <span className="inline-flex items-center overflow-hidden rounded-[6px] border-[1.5px] border-ink bg-card text-[12px] font-semibold shadow-[2px_2px_0_0_var(--color-ink)]">
            <button
              type="button"
              aria-label="Lower limit"
              className="h-[27px] w-9 hover:bg-paper disabled:opacity-40"
              disabled={current.cap <= 5}
              onClick={() => {
                update(
                  { cap: current.cap - 5 },
                  'limit lowered',
                  `→ ${whole.format(current.cap - 5)}`,
                )
              }}
            >
              −
            </button>
            <span className="border-x border-rule px-2 leading-[27px]">
              limit {whole.format(current.cap)}
            </span>
            <button
              type="button"
              aria-label="Raise limit"
              className="h-[27px] w-9 hover:bg-paper disabled:opacity-40"
              disabled={current.cap >= 50}
              onClick={() => {
                update(
                  { cap: current.cap + 5 },
                  'limit raised',
                  `→ ${whole.format(current.cap + 5)}`,
                )
              }}
            >
              +
            </button>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              update(
                { revoked: !current.revoked },
                current.revoked ? 'restored' : 'revoked',
                current.revoked ? 'can call again' : 'calls stop',
              )
            }}
          >
            {current.revoked ? 'Restore' : 'Revoke'}
          </button>
          <button
            type="button"
            className="-mr-2 ml-auto h-[30px] px-2 text-[12px] font-semibold text-mute underline-offset-2 hover:text-ink hover:underline"
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
          className="flex-1 space-y-1.5 px-3 py-3 text-[12px]"
          aria-live="polite"
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
        <p className="border-t border-rule px-4 py-2.5 text-[11.5px] text-mute">
          Changes take effect on the next call.
        </p>
      </div>
    </div>
  )
}
