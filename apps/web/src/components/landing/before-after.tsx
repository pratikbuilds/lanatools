import { motion, useInView, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { AGENTS } from './logos'
import { LogoGlyph } from './logo'
import { CAPABILITIES } from './data'
import { EASE } from './reveal'

const AGENT_Y = AGENTS.map((_, i) => 34 + i * 54)
const PROVIDER_Y = CAPABILITIES.map((_, i) => 52 + i * 62)
const AGENT_RIGHT = 118
const PROVIDER_LEFT = 322
const MID = { x: 220, y: 142 }

function curve(x1: number, y1: number, x2: number, y2: number) {
  const dx = (x2 - x1) / 2
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`
}

const HUB_IN = MID.x - 56
const HUB_OUT = MID.x + 56

// Agent -> hub -> provider, as one path a call can travel.
function throughHub(ay: number, py: number) {
  const tail = curve(HUB_OUT, MID.y, PROVIDER_LEFT, py).replace(
    /^M\S+ \S+ /,
    '',
  )
  return `${curve(AGENT_RIGHT, ay, HUB_IN, MID.y)} L${HUB_OUT} ${MID.y} ${tail}`
}

type Route = { d: string; dur: number; begin: number }

// Illustrative traffic. Today: direct and uneven. With lanatools: every
// call goes through the hub on a steady beat.
const DIRECT: Array<Route> = [
  [0, 2, 2.4],
  [1, 0, 3.1],
  [2, 3, 2.1],
  [3, 1, 3.6],
  [4, 2, 2.7],
  [0, 3, 3.3],
  [2, 0, 2.9],
].map(([a, p, dur], i) => ({
  d: curve(AGENT_RIGHT, AGENT_Y[a!] ?? 0, PROVIDER_LEFT, PROVIDER_Y[p!] ?? 0),
  dur: dur!,
  begin: 0.3 + i * 0.47,
}))

const BEAT = 0.7
const HUBBED: Array<Route> = [
  [0, 0],
  [2, 2],
  [4, 1],
  [1, 3],
  [3, 0],
].map(([a, p], i) => ({
  d: throughHub(AGENT_Y[a!] ?? 0, PROVIDER_Y[p!] ?? 0),
  dur: BEAT * 5,
  begin: i * BEAT,
}))

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

function Agents({ keys }: { keys: boolean }) {
  return (
    <>
      {AGENTS.map((a, i) => {
        const y = AGENT_Y[i] ?? 0
        return (
          <g key={a.id}>
            <rect
              x={10}
              y={y - 17}
              width={108}
              height={34}
              rx={6}
              className="fill-card stroke-ink"
              strokeWidth={1.5}
            />
            <LogoGlyph id={a.id} x={20} y={y - 7} size={14} />
            <text
              x={40}
              y={y + 4.5}
              className={`fill-ink font-bold ${a.id === 'others' ? 'text-[10px]' : 'text-[13px]'}`}
            >
              {a.name}
            </text>
            {keys && (
              <g>
                <rect
                  x={88}
                  y={y - 27}
                  width={34}
                  height={17}
                  rx={3}
                  className="fill-coral stroke-ink"
                  strokeWidth={1}
                />
                <text
                  x={105}
                  y={y - 14.5}
                  textAnchor="middle"
                  className="fill-ink text-[11px] font-bold"
                >
                  key
                </text>
              </g>
            )}
          </g>
        )
      })}
    </>
  )
}

function Capabilities() {
  return (
    <>
      {CAPABILITIES.map((p, i) => {
        const y = PROVIDER_Y[i] ?? 0
        return (
          <g key={p.name}>
            <rect
              x={PROVIDER_LEFT}
              y={y - 17}
              width={114}
              height={34}
              rx={6}
              className="fill-card stroke-ink"
              strokeWidth={1.5}
            />
            <image
              href={p.icon}
              x={PROVIDER_LEFT + 7}
              y={y - 8}
              width={16}
              height={16}
            >
              <title>{p.name}</title>
            </image>
            <text
              x={PROVIDER_LEFT + 29}
              y={y + 4.5}
              className="fill-ink text-[10.5px] font-bold"
            >
              {p.name}
            </text>
          </g>
        )
      })}
    </>
  )
}

function Panel({
  after,
  label,
  body,
}: {
  after: boolean
  label: string
  body: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '0px 0px -20% 0px' })
  const reduced = useReducedMotion()
  // Wait for the wires to finish drawing before traffic starts.
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!inView || reduced) return
    const timer = setTimeout(() => setLive(true), after ? 1300 : 1500)
    return () => clearTimeout(timer)
  }, [inView, reduced, after])

  const wires = after
    ? [
        ...AGENT_Y.map((y) => curve(AGENT_RIGHT, y, MID.x - 56, MID.y)),
        ...PROVIDER_Y.map((y) => curve(MID.x + 56, MID.y, PROVIDER_LEFT, y)),
      ]
    : AGENT_Y.flatMap((ay) =>
        PROVIDER_Y.map((py) => curve(AGENT_RIGHT, ay, PROVIDER_LEFT, py)),
      )

  return (
    <div ref={ref} className="box box-lg flex flex-col overflow-hidden">
      <div className="border-b-[1.5px] border-ink bg-paper px-4 py-2.5 text-[12px]">
        <span className="font-semibold">{label}</span>
      </div>
      <div className="px-3 py-4 sm:px-5">
        <svg viewBox="0 0 448 300" className="h-auto w-full" aria-hidden="true">
          <g
            fill="none"
            className={after ? 'stroke-ink' : 'stroke-ink/45'}
            strokeWidth={after ? 1.5 : 1}
          >
            {wires.map((d, i) => (
              <motion.path
                key={d}
                d={d}
                initial={{ pathLength: 0 }}
                animate={inView ? { pathLength: 1 } : { pathLength: 0 }}
                transition={{
                  duration: after ? 0.7 : 0.5,
                  ease: EASE,
                  delay: 0.15 + i * (after ? 0.07 : 0.035),
                }}
              />
            ))}
          </g>
          {live && (
            <Packets
              routes={after ? HUBBED : DIRECT}
              tone={after ? 'lime' : 'card'}
            />
          )}
          <Agents keys={!after} />
          <Capabilities />
          {after && (
            <motion.g
              initial={{ scale: 0.6, opacity: 0 }}
              animate={inView ? { scale: 1, opacity: 1 } : {}}
              transition={{ type: 'spring', bounce: 0.4, delay: 0.1 }}
              style={{ transformOrigin: `${MID.x}px ${MID.y}px` }}
            >
              {live && (
                <g transform={`translate(${MID.x} ${MID.y})`}>
                  <rect
                    x={-56}
                    y={-30}
                    width={112}
                    height={60}
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
                x={MID.x - 56}
                y={MID.y - 30}
                width={112}
                height={60}
                rx={8}
                className="fill-lime stroke-ink"
                strokeWidth={1.5}
              />
              <text
                x={MID.x}
                y={MID.y - 4}
                textAnchor="middle"
                className="fill-ink text-[14px] font-bold"
              >
                lanatools
              </text>
              <text
                x={MID.x}
                y={MID.y + 15}
                textAnchor="middle"
                className="fill-ink text-[11px]"
              >
                one URL
              </text>
            </motion.g>
          )}
        </svg>
      </div>
      <p className="mt-auto border-t border-rule px-4 py-3.5 text-[13.5px] text-mute sm:px-5">
        {body}
      </p>
    </div>
  )
}

export function BeforeAfter() {
  return (
    <div className="grid gap-6 md:grid-cols-2 md:gap-8">
      <Panel
        after={false}
        label="today"
        body="Each agent and service pair needs its own server, key, and config. Add a service and you repeat it five times."
      />
      <Panel
        after
        label="with lanatools"
        body="Each agent connects once, with one URL and no keys in its config. Add a service and every agent can reach it."
      />
      <p className="text-[12px] text-mute md:col-span-2">
        Connect OpenClaw, Hermes, and other MCP-compatible clients and
        harnesses.
      </p>
    </div>
  )
}
