import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
} from 'motion/react'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { EASE } from './reveal'

const STORAGE_KEY = 'lanatools:early-access'

// The joined email, shared by every form on the page so joining in the hero
// also updates the closing section. Browser storage can be missing or
// blocked, so memory is the source of truth and storage only restores it.
let joinedEmail = readStored()
const listeners = new Set<() => void>()

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function setJoinedEmail(email: string | null) {
  joinedEmail = email
  try {
    if (email) localStorage.setItem(STORAGE_KEY, email)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage is unavailable; the page still remembers until it reloads.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    joinedEmail = event.newValue
    listener()
  }
  listeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function useJoinedEmail() {
  return useSyncExternalStore(
    subscribe,
    () => joinedEmail,
    () => null,
  )
}

// There is no waitlist API yet, so a signup is only remembered in this
// browser. Replace the wait with the request once the waitlist is stored.
async function requestAccess(_email: string) {
  await wait(650)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Tone = 'blue' | 'paper'

export function EarlyAccess({ tone, note }: { tone: Tone; note?: ReactNode }) {
  const email = useJoinedEmail()
  return (
    // Size from the container, never the content: the ticket's single line
    // would otherwise stretch narrow layouts instead of truncating.
    <div className="w-full max-w-[34rem] [contain:inline-size]">
      <AnimatePresence mode="wait" initial={false}>
        {email ? (
          <Ticket key="ticket" email={email} tone={tone} />
        ) : (
          <JoinForm key="form" tone={tone} note={note} />
        )}
      </AnimatePresence>
    </div>
  )
}

function JoinForm({ tone, note }: { tone: Tone; note?: ReactNode }) {
  const inputId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  const shake = useAnimationControls()
  const still = useReducedMotion()
  const [error, setError] = useState('')
  const [focused, setFocused] = useState(false)
  const [phase, setPhase] = useState<'edit' | 'busy' | 'done'>('edit')
  const busy = phase !== 'edit'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const field = input.current
    if (!field || busy) return
    const value = field.value.trim()
    if (!value || !field.validity.valid) {
      setError(
        value
          ? 'That email doesn’t look right. Check it and try again.'
          : 'Enter your email to join the list.',
      )
      field.focus()
      void shake.start({
        x: [0, -7, 7, -4, 4, 0],
        transition: { duration: 0.36, ease: 'easeOut' },
      })
      return
    }
    setError('')
    setPhase('busy')
    try {
      await requestAccess(value)
    } catch {
      setError('We couldn’t add you just now. Try again.')
      setPhase('edit')
      return
    }
    // Let the packet line settle before the ticket replaces the form.
    setPhase('done')
    if (!still) await wait(480)
    setJoinedEmail(value)
  }

  return (
    <motion.form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-label="Join the early access list"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: 0.25, ease: EASE }}
    >
      <label htmlFor={inputId} className="sr-only">
        Email address
      </label>
      {/* .box is unlayered CSS, so state overrides need !important. */}
      <motion.div
        animate={shake}
        className={`box flex flex-col overflow-hidden transition-shadow sm:flex-row ${
          tone === 'blue'
            ? 'focus-within:shadow-[4px_4px_0_0_var(--color-lime)]!'
            : 'focus-within:shadow-[4px_4px_0_0_var(--color-blue)]!'
        } ${error ? 'border-coral!' : ''}`}
      >
        <div className="relative flex min-w-0 sm:flex-1">
          <input
            ref={input}
            id={inputId}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            placeholder="you@domain.com"
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={() => error && setError('')}
            className="h-12 w-full min-w-0 bg-transparent px-4 text-[15px] text-ink outline-none! placeholder:text-mute/70 disabled:opacity-60"
          />
          <Packet
            state={
              phase === 'edit' ? (focused && !error ? 'live' : 'idle') : phase
            }
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="group flex h-12 shrink-0 items-center justify-center gap-2 border-t-[1.5px] border-ink bg-lime px-5 text-[13.5px] font-semibold text-ink transition-colors hover:bg-[#e6ff7a] disabled:cursor-progress sm:min-w-[11.75rem] sm:border-t-0 sm:border-l-[1.5px]"
        >
          {busy ? (
            <>
              {phase === 'done' ? <span aria-hidden="true">✓</span> : <Dots />}
              {phase === 'done' ? 'Joined' : 'Joining'}
            </>
          ) : (
            <>
              Get early access
              <span
                aria-hidden="true"
                className="transition-transform duration-200 ease-(--ease-out) group-hover:translate-x-0.5"
              >
                →
              </span>
            </>
          )}
        </button>
      </motion.div>
      <p
        id={errorId}
        role="alert"
        className={`mt-2.5 text-[12.5px] empty:hidden ${
          tone === 'blue' ? 'text-paper' : 'text-coral-ink'
        }`}
      >
        {error && (
          <span
            aria-hidden="true"
            className="mr-2 inline-block size-2 rounded-full bg-coral align-middle"
          />
        )}
        {error}
      </p>
      {!error && (
        <p
          className={`mt-2.5 text-[12.5px] ${
            tone === 'blue' ? 'text-paper-2' : 'text-mute'
          }`}
        >
          {note ??
            'Invites go out in small batches. One email when yours is ready.'}
        </p>
      )}
    </motion.form>
  )
}

// The footer's payment packet, running along the bottom of the field: it
// cruises while you type, races while the request is out, then settles into
// a solid line once you are in.
function Packet({ state }: { state: 'idle' | 'live' | 'busy' | 'done' }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] overflow-hidden"
    >
      <motion.span
        className="absolute inset-0 origin-left bg-blue"
        initial={false}
        animate={{ scaleX: state === 'done' ? 1 : 0 }}
        transition={{ duration: 0.45, ease: EASE }}
      />
      {(state === 'live' || state === 'busy') && (
        <span
          className="field-packet"
          style={{ animationDuration: state === 'busy' ? '0.7s' : '2.2s' }}
        />
      )}
    </span>
  )
}

function Dots() {
  return (
    <span aria-hidden="true" className="flex gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-[5px] rounded-full bg-ink"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
    </span>
  )
}

// The footer ledger's glyphs: amounts, hashes, money in motion.
const GLYPHS = '$0123456789abcdef#%&@'
// How many characters the lit front spans while it decodes.
const SPREAD = 6
const TITLE = 'You’re on the list.'

const pickGlyph = () => GLYPHS.charAt((Math.random() * GLYPHS.length) | 0)
const scramble = (text: string) =>
  Array.from(text, (char) => (char === ' ' ? ' ' : pickGlyph())).join('')

// Text decoding out of ledger glyphs at `frame`: settled characters, a lit
// front like the footer's lime letters, then noise where the rest will land.
function Decoding({ text, frame }: { text: string; frame: number }) {
  if (frame >= text.length + SPREAD) return <>{text}</>
  const settled = Math.max(0, frame - SPREAD)
  const lit = Math.max(0, Math.min(frame, text.length))
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {text.slice(0, settled)}
        <span className="rounded-[2px] bg-lime text-ink">
          {scramble(text.slice(settled, lit))}
        </span>
        <span className="opacity-35">{scramble(text.slice(lit))}</span>
      </span>
    </>
  )
}

// One row, the same height as the form it replaces. It lands as a line of
// ledger noise and decodes left to right into the confirmation.
function Ticket({ email, tone }: { email: string; tone: Tone }) {
  const still = useReducedMotion()
  const end = TITLE.length + email.length + SPREAD
  // Start a few frames early so the noise shows before the front arrives.
  const [frame, setFrame] = useState(-8)

  useEffect(() => {
    if (still) return
    const id = setInterval(() => {
      setFrame((f) => {
        if (f + 1 >= end) clearInterval(id)
        return Math.min(f + 1, end)
      })
    }, 26)
    return () => clearInterval(id)
  }, [still, end])

  const at = still ? end : frame
  const done = at >= end

  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
    >
      <div className="box flex h-12 min-w-0 items-center gap-3 overflow-hidden px-3.5 text-[13.5px]">
        <motion.span
          className="flex size-7 shrink-0 items-center justify-center rounded-[6px] border-[1.5px] border-ink bg-lime"
          initial={{ rotate: -12, scale: 0.6 }}
          animate={{ rotate: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 18 }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <motion.path
              d="M3.5 8.5 6.5 11.5 12.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35, ease: EASE, delay: 0.15 }}
            />
          </svg>
        </motion.span>
        <span className="shrink-0 font-bold whitespace-nowrap">
          <Decoding text={TITLE} frame={at} />
        </span>
        <span className="min-w-0 truncate text-mute" title={email}>
          <Decoding text={email} frame={at - TITLE.length} />
        </span>
        <span
          aria-hidden="true"
          className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap text-mute/35 transition-opacity duration-500 ${
            done ? 'opacity-0' : ''
          }`}
        >
          {scramble('0'.repeat(48))}
        </span>
        <span className="chip chip-lime shrink-0 text-[10.5px] tracking-wide uppercase max-sm:hidden!">
          early access
        </span>
      </div>
      <p
        className={`mt-2.5 text-[12.5px] ${
          tone === 'blue' ? 'text-paper-2' : 'text-mute'
        }`}
      >
        Waiting for the next batch. We’ll email you.{' '}
        <button
          type="button"
          onClick={() => setJoinedEmail(null)}
          className={`underline underline-offset-3 ${
            tone === 'blue' ? 'hover:text-paper' : 'hover:text-ink'
          }`}
        >
          Use a different email
        </button>
      </p>
    </motion.div>
  )
}
