import { useState } from 'react'
import {
  MAX_CLIENT_LIMIT_MICRO_USD,
  formatUsd,
  parseClientLimit,
} from '@lanatools/contracts'
import type { McpClient } from '@lanatools/contracts'
import { AnimatedCounter } from '#/components/ui/animated-counter'

const TICKS = 41
const RULER_STEPS = 1000
const CENT = 10_000

/** A limit as the amount field shows it: dollars, no sign, no grouping. */
function fieldValue(microUsd: number) {
  return formatUsd(microUsd).slice(1).replaceAll(',', '')
}

/** Two decimals, or as many as a sub-cent limit needs. */
function decimalsFor(microUsd: number) {
  let decimals = 6
  for (let rest = microUsd; decimals > 2 && rest % 10 === 0; rest /= 10)
    decimals--
  return decimals
}

/**
 * Changes a client's spending limit, by dragging the ruler or by typing an
 * exact amount; each follows the other, and the large figure rolls to match.
 *
 * The ruler runs from nothing to what the wallet can cover for this client:
 * what it has already used plus the whole balance. A limit is cumulative, so
 * the balance alone would be too short for a client that has spent more than
 * the wallet now holds. The field takes any limit a client may have.
 */
export function LimitEditor({
  client,
  balanceMicroUsd,
  onSave,
}: {
  client: McpClient
  /** The wallet's USDC balance, or undefined while it is not known. */
  balanceMicroUsd: number | undefined
  onSave: (limitUsd: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(() => fieldValue(client.limitMicroUsd))
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const typed = parseClientLimit(draft)
  // An amount that cannot be a limit leaves the figure on the saved one.
  const limit = typed ?? client.limitMicroUsd
  const name = client.clientName ?? 'This client'
  const used = client.spentMicroUsd + client.reservedMicroUsd
  const top =
    balanceMicroUsd === undefined
      ? undefined
      : Math.min(MAX_CLIENT_LIMIT_MICRO_USD, used + balanceMicroUsd)

  function edit(value: string) {
    setFailed(false)
    setDraft(value)
  }

  async function save() {
    if (typed === null) return
    setSaving(true)
    setFailed(false)
    try {
      await onSave(draft)
    } catch {
      // Keep the draft so the same amount can be saved again.
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <p className="d-label">Spending limit</p>
      <AnimatedCounter
        value={limit / 1_000_000}
        decimals={decimalsFor(limit)}
        prefix="$"
        className="mt-3 mb-2 font-mono text-[3rem] leading-none font-semibold tracking-[-0.05em]"
      />
      <p className="font-mono text-[12px] text-fg-3">
        {formatUsd(Math.max(0, limit - used))} left after {formatUsd(used)} used
      </p>

      {top !== undefined && top > 0 && (
        <LimitRuler
          limit={limit}
          top={top}
          disabled={saving}
          onChange={(next) => edit(fieldValue(next))}
        />
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <label className="flex h-[34px] items-center gap-1 rounded-[9px] border border-line-2 bg-surface pl-3 font-mono font-semibold has-aria-invalid:border-bad has-focus-visible:border-accent">
          <span className="text-fg-3">$</span>
          <input
            className="h-full w-28 rounded-r-[9px] bg-transparent pr-2.5 font-mono font-semibold outline-none"
            inputMode="decimal"
            aria-label="New spending limit in USD"
            aria-invalid={typed === null}
            value={draft}
            disabled={saving}
            onChange={(event) => edit(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="d-btn d-btn-primary"
          disabled={typed === null || saving}
        >
          {saving ? 'Saving…' : 'Save limit'}
        </button>
        <p role="alert" className="w-full text-[12px] text-bad empty:hidden">
          {typed === null
            ? `Enter an amount up to ${formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}.`
            : failed
              ? 'Could not change the limit. Try again.'
              : typed < used
                ? `${name} has already used ${formatUsd(used)}. It cannot pay until the limit is higher.`
                : ''}
        </p>
        <p className="w-full text-[12px] text-fg-3 empty:hidden">
          {typed !== null &&
          top !== undefined &&
          balanceMicroUsd !== undefined &&
          typed > top
            ? `Your wallet holds ${formatUsd(balanceMicroUsd)}. ${name} can only pay what is in it.`
            : ''}
        </p>
      </div>
    </form>
  )
}

/**
 * A row of tick marks with a native range input laid over it, as in Rare
 * UI's animated counter demo: marks up to the position are dark and the
 * position itself is a taller mark.
 */
function LimitRuler({
  limit,
  top,
  disabled,
  onChange,
}: {
  limit: number
  top: number
  disabled: boolean
  onChange: (limitMicroUsd: number) => void
}) {
  const position = Math.min(
    RULER_STEPS,
    Math.round((limit / top) * RULER_STEPS),
  )
  const at = Math.round((position / RULER_STEPS) * (TICKS - 1))

  return (
    <>
      <div className="relative mt-5 h-[46px] rounded-[9px] border border-line bg-surface px-3 pt-1.5 pb-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent">
        <div
          aria-hidden="true"
          className="flex h-full items-end justify-between"
        >
          {Array.from({ length: TICKS }, (_, tick) => (
            <span
              key={tick}
              className={`rounded-[1px] transition-[height,background-color] duration-200 motion-reduce:transition-none ${
                tick === at
                  ? '-mx-[0.5px] h-[30px] w-[3px] bg-fg'
                  : `h-[18px] w-[2px] ${tick < at ? 'bg-tick' : 'bg-line-2'}`
              }`}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={RULER_STEPS}
          step={1}
          value={position}
          disabled={disabled}
          aria-label="Spending limit"
          aria-valuetext={formatUsd(limit)}
          onChange={(event) =>
            // The ruler moves in whole cents.
            onChange(
              Math.round(
                ((Number(event.target.value) / RULER_STEPS) * top) / CENT,
              ) * CENT,
            )
          }
          className="absolute inset-0 m-0 size-full cursor-ew-resize opacity-0"
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11.5px] text-fg-3">
        <span>$0</span>
        <span>
          {formatUsd(top)}
          {top === MAX_CLIENT_LIMIT_MICRO_USD
            ? ', the most a client can have'
            : ', your whole wallet'}
        </span>
      </div>
    </>
  )
}
