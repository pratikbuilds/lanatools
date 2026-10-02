import {
  animate,
  motion,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { MotionValue } from 'motion/react'
import { AGENTS } from './logos'
import { LogoGlyph } from './logo'
import { CAPABILITIES } from './data'
import { EASE } from './reveal'

// One drawing, two states. `progress` runs 0 (today) to 1 (with lanatools):
// the tangle of direct wires gathers into a single line through the hub.
// The wide drawing shares its node sizes with the flow diagram below it.
type Geometry = {
  w: number
  h: number
  nodeH: number
  agent: { x: number; w: number; ys: Array<number> }
  cap: { x: number; w: number; ys: Array<number> }
  hub: { x: number; y: number; w: number; h: number }
  compact: boolean
}

const WIDE: Geometry = {
  w: 1040,
  h: 364,
  nodeH: 44,
  agent: { x: 20, w: 176, ys: AGENTS.map((_, i) => 42 + i * 72) },
  cap: { x: 844, w: 176, ys: CAPABILITIES.map((_, i) => 52 + i * 94) },
  hub: { x: 520, y: 186, w: 176, h: 76 },
  compact: false,
}

const NARROW: Geometry = {
  w: 448,
  h: 300,
  nodeH: 34,
  agent: { x: 10, w: 108, ys: AGENTS.map((_, i) => 34 + i * 54) },
  cap: { x: 322, w: 114, ys: CAPABILITIES.map((_, i) => 52 + i * 62) },
  hub: { x: 220, y: 142, w: 112, h: 60 },
  compact: true,
}

type Point = [number, number]

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const mix = (a: Point, b: Point, t: number): Point => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
]
const clamp = (t: number) => Math.min(1, Math.max(0, t))
const ease = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
const at = (p: Point) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`

// A wire from agent `a` to capability `p`. At t=0 it is one direct curve;
// at t=1 it runs into the hub, across it, and out to the capability.
function wirePath(g: Geometry, a: number, p: number, t: number) {
  const start: Point = [g.agent.x + g.agent.w, g.agent.ys[a] ?? 0]
  const end: Point = [g.cap.x, g.cap.ys[p] ?? 0]
  const hubIn: Point = [g.hub.x - g.hub.w / 2, g.hub.y]
  const hubOut: Point = [g.hub.x + g.hub.w / 2, g.hub.y]

  // The direct curve, split in half so both states share one path shape.
  const midX = (start[0] + end[0]) / 2
  const c1: Point = [midX, start[1]]
  const c2: Point = [midX, end[1]]
  const q0 = mix(start, c1, 0.5)
  const q1 = mix(c1, c2, 0.5)
  const q2 = mix(c2, end, 0.5)
  const r0 = mix(q0, q1, 0.5)
  const r1 = mix(q1, q2, 0.5)
  const middle = mix(r0, r1, 0.5)

  const inX = (start[0] + hubIn[0]) / 2
  const outX = (hubOut[0] + end[0]) / 2
  return [
    `M${at(start)}`,
    `C${at(mix(q0, [inX, start[1]], t))}`,
    at(mix(r0, [inX, hubIn[1]], t)),
    at(mix(middle, hubIn, t)),
    `L${at(mix(middle, hubOut, t))}`,
    `C${at(mix(r1, [outX, hubOut[1]], t))}`,
    at(mix(q2, [outX, end[1]], t)),
    at(end),
  ].join(' ')
}

const WIRES = AGENTS.flatMap((_, a) => CAPABILITIES.map((__, p) => ({ a, p })))

// Wires gather one after another, top agent first.
function wireProgress(progress: number, index: number) {
  const start = 0.1 + 0.2 * (index / (WIRES.length - 1))
  return ease(clamp((progress - start) / 0.45))
}

function Wire({
  g,
  a,
  p,
  index,
  progress,
  drawn,
}: {
  g: Geometry
  a: number
  p: number
  index: number
  progress: MotionValue<number>
  drawn: boolean
}) {
  const d = useTransform(progress, (v) =>
    wirePath(g, a, p, wireProgress(v, index)),
  )
  return (
    <motion.path
      d={d}
      initial={{ pathLength: 0 }}
      animate={{ pathLength: drawn ? 1 : 0 }}
      transition={{ duration: 0.5, ease: EASE, delay: 0.15 + index * 0.035 }}
    />
  )
}

type Route = { d: string; dur: number; begin: number }

// Illustrative traffic. Today: direct and uneven. With lanatools: every
// call goes through the hub on a steady beat.
function directRoutes(g: Geometry): Array<Route> {
  return [
    [0, 2, 2.4],
    [1, 0, 3.1],
    [2, 3, 2.1],
    [3, 1, 3.6],
    [4, 2, 2.7],
    [0, 3, 3.3],
    [2, 0, 2.9],
  ].map(([a, p, dur], i) => ({
    d: wirePath(g, a!, p!, 0),
    dur: dur!,
    begin: 0.3 + i * 0.47,
  }))
}

const BEAT = 0.7

function hubRoutes(g: Geometry): Array<Route> {
  return [
    [0, 0],
    [2, 2],
    [4, 1],
    [1, 3],
    [3, 0],
  ].map(([a, p], i) => ({
    d: wirePath(g, a!, p!, 1),
    dur: BEAT * 5,
    begin: i * BEAT,
  }))
}

function Packets({
  routes,
  tone,
}: {
  routes: Array<Route>
  tone: 'lime' | 'card'
}) {
  return (
    <g>
      {routes.map((r) => (
        <rect
          key={r.d}
          x={-5}
          y={-5}
          width={10}
          height={10}
          rx={2}
          opacity={0}
          className={`${tone === 'lime' ? 'fill-lime' : 'fill-card'} stroke-ink`}
          strokeWidth={1.5}
        >
          <animateMotion
            path={r.d}
            dur={`${r.dur}s`}
            begin={`${r.begin}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.06;0.92;1"
            dur={`${r.dur}s`}
            begin={`${r.begin}s`}
            repeatCount="indefinite"
          />
        </rect>
      ))}
    </g>
  )
}

function NodeFrame({
  g,
  x,
  w,
  y,
}: {
  g: Geometry
  x: number
  w: number
  y: number
}) {
  return (
    <rect
      x={x}
      y={y - g.nodeH / 2}
      width={w}
      height={g.nodeH}
      rx={6}
      className="fill-card stroke-ink"
      strokeWidth={1.5}
    />
  )
}

function Agents({ g }: { g: Geometry }) {
  return (
    <>
      {AGENTS.map((a, i) => {
        const y = g.agent.ys[i] ?? 0
        const { x, w } = g.agent
        return (
          <g key={a.id}>
            <NodeFrame g={g} x={x} w={w} y={y} />
            {g.compact ? (
              <>
                <LogoGlyph id={a.id} x={x + 10} y={y - 7} size={14} />
                <text
                  x={x + 30}
                  y={y + 4.5}
                  className={`fill-ink font-bold ${a.id === 'others' ? 'text-[10px]' : 'text-[13px]'}`}
                >
                  {a.name}
                </text>
              </>
            ) : (
              <>
                <LogoGlyph id={a.id} x={x + 14} y={y - 9} size={18} />
                <text
                  x={x + 44}
                  y={y - 2}
                  className="fill-ink text-[15px] font-bold"
                >
                  {a.name}
                </text>
                <text x={x + 44} y={y + 13} className="fill-mute text-[12px]">
                  {a.kind}
                </text>
              </>
            )}
          </g>
        )
      })}
    </>
  )
}

function Capabilities({ g }: { g: Geometry }) {
  return (
    <>
      {CAPABILITIES.map((p, i) => {
        const y = g.cap.ys[i] ?? 0
        const { x, w } = g.cap
        return (
          <g key={p.name}>
            <NodeFrame g={g} x={x} w={w} y={y} />
            <image
              href={p.icon}
              x={x + (g.compact ? 7 : 12)}
              y={y - (g.compact ? 8 : 10)}
              width={g.compact ? 16 : 18}
              height={g.compact ? 16 : 18}
            >
              <title>{p.name}</title>
            </image>
            {g.compact ? (
              <text
                x={x + 29}
                y={y + 4.5}
                className="fill-ink text-[10.5px] font-bold"
              >
                {p.name}
              </text>
            ) : (
              <>
                <text
                  x={x + 40}
                  y={y - 3}
                  className="fill-ink text-[14px] font-bold"
                >
                  {p.name}
                </text>
                <text x={x + 40} y={y + 13} className="fill-mute text-[11px]">
                  {p.note}
                </text>
              </>
            )}
          </g>
        )
      })}
    </>
  )
}

const KEY = { w: 34, h: 17 }

// Each agent's key leaves its config and lands in the hub.
function KeyTag({
  g,
  i,
  progress,
}: {
  g: Geometry
  i: number
  progress: MotionValue<number>
}) {
  const from: Point = [
    g.agent.x + g.agent.w - KEY.w + 4,
    (g.agent.ys[i] ?? 0) - g.nodeH / 2 - 10,
  ]
  const to: Point = [
    g.hub.x + g.hub.w / 2 - KEY.w + 4,
    g.hub.y - g.hub.h / 2 - 10,
  ]
  const t = useTransform(progress, (v) =>
    ease(clamp((v - (0.14 + i * 0.045)) / 0.4)),
  )
  const x = useTransform(t, (k) => (to[0] - from[0]) * k)
  const y = useTransform(
    t,
    (k) => (to[1] - from[1]) * k - Math.sin(Math.PI * k) * 26,
  )
  const opacity = useTransform(t, [0, 0.9, 1], [1, 1, 0])
  return (
    <motion.g style={{ x, y, opacity }}>
      <rect
        x={from[0]}
        y={from[1]}
        width={KEY.w}
        height={KEY.h}
        rx={3}
        className="fill-coral stroke-ink"
        strokeWidth={1}
      />
      <text
        x={from[0] + KEY.w / 2}
        y={from[1] + 12.5}
        textAnchor="middle"
        className="fill-ink text-[11px] font-bold"
      >
        key
      </text>
    </motion.g>
  )
}

function Hub({
  g,
  progress,
  pulse,
}: {
  g: Geometry
  progress: MotionValue<number>
  pulse: boolean
}) {
  const { x, y, w, h } = g.hub
  const scale = useTransform(progress, [0.3, 0.55], [0.5, 1], { ease })
  const opacity = useTransform(progress, [0.3, 0.45], [0, 1])
  const keys = useTransform(progress, [0.66, 0.78], [0, 1])
  return (
    <motion.g style={{ scale, opacity }}>
      {pulse && (
        <g transform={`translate(${x} ${y})`}>
          <rect
            x={-w / 2}
            y={-h / 2}
            width={w}
            height={h}
            rx={8}
            fill="none"
            className="stroke-ink"
            strokeWidth={1.5}
            opacity={0}
          >
            <animate
              attributeName="opacity"
              values="0.5;0"
              dur={`${BEAT}s`}
              repeatCount="indefinite"
            />
            <animateTransform
              attributeName="transform"
              type="scale"
              values="1;1.22"
              dur={`${BEAT}s`}
              additive="sum"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      )}
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        rx={8}
        className="fill-lime stroke-ink"
        strokeWidth={1.5}
      />
      <text
        x={x}
        y={y - 3}
        textAnchor="middle"
        className={`fill-ink font-bold ${g.compact ? 'text-[14px]' : 'text-[17px]'}`}
      >
        lanatools
      </text>
      <text
        x={x}
        y={y + (g.compact ? 15 : 17)}
        textAnchor="middle"
        className={`fill-ink ${g.compact ? 'text-[11px]' : 'text-[12px]'}`}
      >
        one URL
      </text>
      <motion.g style={{ opacity: keys }}>
        <rect
          x={x + w / 2 - 94}
          y={y - h / 2 - 10}
          width={102}
          height={KEY.h}
          rx={3}
          className="fill-ink stroke-ink"
          strokeWidth={1}
        />
        <text
          x={x + w / 2 - 43}
          y={y - h / 2 + 2.5}
          textAnchor="middle"
          className="fill-lime text-[11px] font-bold"
        >
          keys stay here
        </text>
      </motion.g>
    </motion.g>
  )
}

type Phase = 'today' | 'between' | 'after'

function Diagram({
  g,
  progress,
  phase,
  inView,
  live,
}: {
  g: Geometry
  progress: MotionValue<number>
  phase: Phase
  inView: boolean
  live: boolean
}) {
  const strokeOpacity = useTransform(progress, [0.1, 0.7], [0.45, 1])
  const strokeWidth = useTransform(progress, [0.1, 0.7], [1, 1.5])
  return (
    <svg
      viewBox={`0 0 ${g.w} ${g.h}`}
      className="h-auto w-full"
      aria-hidden="true"
    >
      <motion.g
        fill="none"
        className="stroke-ink"
        style={{ strokeOpacity, strokeWidth }}
      >
        {WIRES.map(({ a, p }, i) => (
          <Wire
            key={`${a}-${p}`}
            g={g}
            a={a}
            p={p}
            index={i}
            progress={progress}
            drawn={inView}
          />
        ))}
      </motion.g>
      {live && phase === 'today' && (
        <Packets routes={directRoutes(g)} tone="card" />
      )}
      {live && phase === 'after' && (
        <Packets routes={hubRoutes(g)} tone="lime" />
      )}
      <Agents g={g} />
      <Capabilities g={g} />
      <Hub g={g} progress={progress} pulse={live && phase === 'after'} />
      {AGENTS.map((a, i) => (
        <KeyTag key={a.id} g={g} i={i} progress={progress} />
      ))}
    </svg>
  )
}

function useWideLayout() {
  const ref = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = () => setWide(el.clientWidth >= 640)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, wide }
}

const phaseOf = (v: number): Phase =>
  v < 0.06 ? 'today' : v > 0.8 ? 'after' : 'between'

// How long each state rests, and how long the change between them takes.
const HOLD = { today: 3200, after: 6500 }
const MORPH = { connect: 2.4, release: 1.5 }

const STATES = [
  {
    label: 'today',
    chip: 'chip-coral',
    body: 'Each agent and tool pair needs its own server, key, and config. Add a tool and you repeat it five times.',
  },
  {
    label: 'with lanatools',
    chip: 'chip-lime',
    body: 'Each agent connects once, with one URL and no keys in its config. Add a tool and every agent can use it.',
  },
]

export function BeforeAfter() {
  const reduced = useReducedMotion()
  const { ref, wide } = useWideLayout()
  const seen = useInView(ref, { once: true, margin: '0px 0px -20% 0px' })
  // The loop runs while any part of the figure, tabs included, is on screen.
  const figure = useRef<HTMLElement>(null)
  const visible = useInView(figure)
  const progress = useMotionValue(0)
  // Wait for the wires to finish drawing before traffic starts.
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!seen || reduced) return
    const timer = setTimeout(() => setLive(true), 1500)
    return () => clearTimeout(timer)
  }, [seen, reduced])

  const [phase, setPhase] = useState<Phase>('today')
  const [after, setAfter] = useState(false)
  useMotionValueEvent(progress, 'change', (v) => {
    setPhase(phaseOf(v))
    setAfter(v > 0.5)
  })

  // Picking a state by hand moves there, then the loop carries on from it.
  const [picked, setPicked] = useState<{ to: 0 | 1 } | null>(null)

  useEffect(() => {
    if (reduced) {
      progress.set(picked?.to ?? 1)
      return
    }
    if (!visible) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let controls: ReturnType<typeof animate> | undefined
    const moveTo = (to: 0 | 1, duration: number) => {
      controls = animate(progress, to, { duration, ease: 'linear' })
      controls.then(() => {
        if (stopped) return
        timer = setTimeout(
          () => moveTo(to ? 0 : 1, to ? MORPH.release : MORPH.connect),
          to ? HOLD.after : HOLD.today,
        )
      })
    }
    if (picked) moveTo(picked.to, picked.to ? MORPH.connect : MORPH.release)
    else {
      const next = progress.get() > 0.5 ? 0 : 1
      timer = setTimeout(
        () => moveTo(next, next ? MORPH.connect : MORPH.release),
        next ? HOLD.today : HOLD.after,
      )
    }
    return () => {
      stopped = true
      clearTimeout(timer)
      controls?.stop()
    }
  }, [reduced, visible, picked, progress])

  return (
    <div>
      <figure ref={figure} className="box box-lg m-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b-[1.5px] border-ink bg-paper px-4 py-2.5 text-[12px] text-mute">
          <div className="flex items-center gap-2">
            {STATES.map((state, i) => {
              const on = after === (i === 1)
              return (
                <button
                  key={state.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked({ to: i === 1 ? 1 : 0 })}
                  className={`chip cursor-pointer transition-colors duration-200 ${on ? state.chip : 'text-mute hover:text-ink'}`}
                >
                  {state.label}
                </button>
              )
            })}
          </div>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-[2px] border border-ink bg-coral"
              />
              a key in an agent&rsquo;s config
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block size-2.5 rounded-[2px] border border-ink transition-colors duration-200 ${after ? 'bg-lime' : 'bg-card'}`}
              />
              a call from an agent
            </span>
          </span>
        </div>
        <div ref={ref} className={wide ? 'px-4 py-6 sm:px-6' : 'px-3 py-5'}>
          <Diagram
            key={wide ? 'wide' : 'narrow'}
            g={wide ? WIDE : NARROW}
            progress={progress}
            phase={phase}
            inView={seen}
            live={live}
          />
        </div>
        <figcaption className="grid border-t-[1.5px] border-ink bg-paper sm:grid-cols-2">
          {STATES.map((state, i) => {
            const on = after === (i === 1)
            return (
              <div
                key={state.label}
                className={`flex flex-col items-start gap-2 border-rule px-4 py-4 transition-opacity duration-300 not-last:border-b sm:px-5 sm:not-last:border-r sm:not-last:border-b-0 ${on ? 'opacity-100' : 'opacity-45'}`}
              >
                <span className={`chip ${on ? state.chip : ''}`}>
                  {state.label}
                </span>
                <span className="text-[13px] leading-relaxed text-mute">
                  {state.body}
                </span>
              </div>
            )
          })}
        </figcaption>
      </figure>
      <p className="mt-6 text-[12px] text-mute">
        Connect OpenClaw, Hermes, and other MCP-compatible clients and
        harnesses.
      </p>
    </div>
  )
}
