import { useEffect, useRef, useState } from 'react'
import { MCP_HOST } from './copy-url'
import { CAPABILITIES } from './data'
import {
  CROSSING_MESSAGES,
  ENTRY,
  EXIT,
  PERIOD,
  PHASE,
  STAGGER,
} from './crossing'
import { LogoGlyph } from './logo'
import { AGENTS } from './logos'
import type { AgentId } from './logos'

type Box = { x: number; y: number; w: number; h: number }
type Node = {
  name: string
  note: string
  box: Box
  logo?: AgentId
  icon?: string
}
type Provider = Node & { cost: string; paid: boolean; tag: Box }

type Layout = {
  viewBox: string
  sources: Array<Node>
  providers: Array<Provider>
  wires: Array<string>
  gate: Box
  stem: string
  url: Box
  denied: { d: string; tag: Box }
  routes: Array<{ d: string; entry: number; exit: number }>
  still: Array<[number, number]>
  stillDenied: [number, number]
  // Numbered markers that tie the diagram to the steps below it.
  marks: Array<[number, number]>
}

const DENIED_BEGIN = 2.2

const SOURCES = AGENTS.map((a) => ({ name: a.name, note: a.kind, logo: a.id }))

const WIDE: Layout = {
  viewBox: '0 0 1040 360',
  sources: SOURCES.map((src, i) => ({
    ...src,
    box: { x: 20, y: 20 + i * 72, w: 176, h: 44 },
  })),
  providers: CAPABILITIES.map((p, i) => ({
    ...p,
    box: { x: 844, y: 30 + i * 94, w: 176, h: 44 },
    tag: { x: 844, y: 6 + i * 94, w: 92, h: 20 },
  })),
  wires: [
    'M196 42 H240 V186',
    'M196 114 H240 V186',
    'M196 186 H240',
    'M196 258 H240 V186',
    'M196 330 H240 V186',
    'M800 186 V52 H844',
    'M800 186 V146 H844',
    'M800 186 V240 H844',
    'M800 186 V334 H844',
  ],
  gate: { x: 390, y: 142, w: 260, h: 88 },
  stem: 'M240 186 H800',
  url: { x: 455, y: 242, w: 130, h: 22 },
  denied: {
    d: 'M196 330 H240 V186 H384',
    tag: { x: 232, y: 151, w: 148, h: 22 },
  },
  routes: [
    { d: 'M196 42 H240 V186 H800 V52 H832', entry: 338 / 914, exit: 598 / 914 },
    {
      d: 'M196 114 H240 V186 H800 V146 H832',
      entry: 266 / 748,
      exit: 526 / 748,
    },
    { d: 'M196 186 H800 V240 H832', entry: 194 / 690, exit: 454 / 690 },
    {
      d: 'M196 330 H240 V186 H800 V334 H832',
      entry: 338 / 928,
      exit: 598 / 928,
    },
  ],
  still: [
    [240, 114],
    [350, 186],
    [800, 240],
    [832, 334],
  ],
  stillDenied: [384, 186],
  marks: [
    [441, 253],
    [404, 142],
    [822, 186],
  ],
}

const TALL: Layout = {
  viewBox: '0 0 390 646',
  sources: SOURCES.map((src, i) => ({
    ...src,
    box: { x: 14 + i * 75, y: 10, w: 68, h: 54 },
  })),
  providers: CAPABILITIES.map((p, i) => ({
    ...p,
    box: { x: 8 + i * 96, y: 548, w: 88, h: 48 },
    tag: { x: 10 + i * 96, y: 606, w: 84, h: 20 },
  })),
  wires: [
    'M48 64 V110 H197',
    'M122 64 V110 H197',
    'M197 64 V110',
    'M271 64 V110 H197',
    'M345 64 V110 H197',
    'M197 480 H52 V548',
    'M197 480 H148 V548',
    'M197 480 H244 V548',
    'M197 480 H340 V548',
  ],
  gate: { x: 67, y: 245, w: 260, h: 120 },
  stem: 'M197 110 V480',
  url: { x: 115, y: 377, w: 164, h: 22 },
  denied: {
    d: 'M345 64 V110 H197 V239',
    tag: { x: 8, y: 204, w: 148, h: 22 },
  },
  routes: [
    { d: 'M48 64 V110 H197 V480 H52 V536', entry: 330 / 766, exit: 450 / 766 },
    {
      d: 'M122 64 V110 H197 V480 H148 V536',
      entry: 256 / 596,
      exit: 376 / 596,
    },
    { d: 'M197 64 V480 H244 V536', entry: 181 / 519, exit: 301 / 519 },
    {
      d: 'M345 64 V110 H197 V480 H340 V536',
      entry: 329 / 763,
      exit: 449 / 763,
    },
  ],
  still: [
    [122, 110],
    [197, 160],
    [197, 420],
    [280, 480],
  ],
  stillDenied: [197, 239],
  marks: [
    [160, 87],
    [81, 245],
    [197, 505],
  ],
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function NodeBox({ node, small }: { node: Node; small: boolean }) {
  const { x, y, w, h } = node.box
  if (node.logo && small) {
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={6}
          className="fill-card stroke-ink"
          strokeWidth={1.5}
        />
        <LogoGlyph id={node.logo} x={x + w / 2 - 8} y={y + 9} size={16} />
        <text
          x={x + w / 2}
          y={y + h - 12}
          textAnchor="middle"
          className="fill-ink text-[10px] font-bold"
        >
          {node.logo === 'others' ? 'Others' : node.name}
        </text>
      </g>
    )
  }
  if (node.logo) {
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={6}
          className="fill-card stroke-ink"
          strokeWidth={1.5}
        />
        <LogoGlyph id={node.logo} x={x + 14} y={y + h / 2 - 9} size={18} />
        <text
          x={x + 44}
          y={y + h / 2 - 2}
          className="fill-ink text-[15px] font-bold"
        >
          {node.name}
        </text>
        <text x={x + 44} y={y + h / 2 + 13} className="fill-mute text-[12px]">
          {node.note}
        </text>
      </g>
    )
  }
  const cx = x + w / 2
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        className="fill-card stroke-ink"
        strokeWidth={1.5}
      />
      <image
        href={node.icon}
        x={small ? cx - 7 : x + 12}
        y={small ? y + 7 : y + h / 2 - 10}
        width={small ? 14 : 18}
        height={small ? 14 : 18}
      >
        <title>{node.name}</title>
      </image>
      <text
        x={small ? cx : x + 40}
        y={small ? y + h - 10 : y + h / 2 - 3}
        textAnchor={small ? 'middle' : 'start'}
        className={`fill-ink font-bold ${small ? 'text-[10px]' : 'text-[14px]'}`}
      >
        {node.name}
      </text>
      {!small && (
        <text x={x + 40} y={y + h / 2 + 13} className="fill-mute text-[11px]">
          {node.note}
        </text>
      )}
    </g>
  )
}

function Mark({ at, n }: { at: [number, number]; n: number }) {
  return (
    <g aria-hidden="true">
      <circle
        cx={at[0]}
        cy={at[1]}
        r={10}
        className="fill-ink stroke-card"
        strokeWidth={1.5}
      />
      <text
        x={at[0]}
        y={at[1] + 4}
        textAnchor="middle"
        className="fill-lime text-[11px] font-bold"
      >
        {n}
      </text>
    </g>
  )
}

function Tag({
  box,
  text,
  tone,
  appear,
}: {
  box: Box
  text: string
  tone: 'lime' | 'card' | 'coral'
  appear?: { begin: number; from: number } | undefined
}) {
  const fill =
    tone === 'lime'
      ? 'fill-lime'
      : tone === 'coral'
        ? 'fill-coral'
        : 'fill-card'
  return (
    <g opacity={appear ? 0 : 1}>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={4}
        className={`${fill} stroke-ink`}
        strokeWidth={1}
      />
      <text
        x={box.x + box.w / 2}
        y={box.y + box.h / 2 + 4}
        textAnchor="middle"
        className="fill-ink text-[11px] font-bold"
      >
        {text}
      </text>
      {appear && <Appear begin={appear.begin} from={appear.from} />}
    </g>
  )
}

function Packet({
  d,
  begin,
  denied,
  crossing,
}: {
  d: string
  begin: number
  denied?: boolean
  crossing?: { entry: number; exit: number }
}) {
  const end = denied ? 0.45 : 0.6
  return (
    <rect
      x={-6}
      y={-6}
      width={12}
      height={12}
      rx={2}
      opacity={0}
      className="fill-lime stroke-ink"
      strokeWidth={1.5}
    >
      <animateMotion
        dur={`${PERIOD}s`}
        begin={`${begin}s`}
        repeatCount="indefinite"
        path={d}
        keyPoints={
          crossing ? `0;${crossing.entry};${crossing.exit};1;1` : '0;1;1'
        }
        keyTimes={crossing ? `0;${ENTRY};${EXIT};${end};1` : `0;${end};1`}
        calcMode="linear"
      />
      <animate
        attributeName="opacity"
        values={denied ? '0;1;1;1;0;0' : '0;1;1;0;0'}
        keyTimes={
          denied ? `0;0.02;${end};0.8;0.85;1` : `0;0.02;${end - 0.02};${end};1`
        }
        dur={`${PERIOD}s`}
        begin={`${begin}s`}
        repeatCount="indefinite"
      />
      {denied && (
        <animate
          attributeName="fill"
          values="#d9ff4a;#d9ff4a;#ff6b4a;#ff6b4a"
          keyTimes={`0;${end - 0.01};${end + 0.01};1`}
          dur={`${PERIOD}s`}
          begin={`${begin}s`}
          repeatCount="indefinite"
        />
      )}
    </rect>
  )
}

function Appear({ begin, from }: { begin: number; from: number }) {
  return (
    <animate
      attributeName="opacity"
      values="0;0;1;1;0;0"
      keyTimes={`0;${from};${from + 0.02};0.88;0.93;1`}
      dur={`${PERIOD}s`}
      begin={`${begin}s`}
      repeatCount="indefinite"
    />
  )
}

// Pauses the SMIL clock while the diagram is offscreen.
function usePauseOffscreen() {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) svg.unpauseAnimations()
      else svg.pauseAnimations()
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])
  return ref
}

function Diagram({ layout, still }: { layout: Layout; still: boolean }) {
  const small = layout === TALL
  const g = layout.gate
  const ref = usePauseOffscreen()
  return (
    <svg
      ref={ref}
      viewBox={layout.viewBox}
      className="h-auto w-full"
      role="img"
      aria-label="Cursor, Claude, Codex, Grok bot, and other agents such as OpenClaw and Hermes connect through one URL to your wallet, which checks each call against that agent's limit and permissions, then routes it to payments, onchain data, transactions, or analytics. A call over its limit is denied at the wallet."
    >
      <path
        d={layout.stem}
        fill="none"
        className="stroke-ink"
        strokeWidth={1.5}
      />
      <g
        fill="none"
        className="stroke-ink"
        strokeWidth={1.5}
        strokeLinejoin="round"
      >
        {layout.wires.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>

      <g>
        <rect
          x={layout.url.x}
          y={layout.url.y}
          width={layout.url.w}
          height={layout.url.h}
          rx={4}
          className="fill-card stroke-ink"
          strokeWidth={1}
        />
        <text
          x={layout.url.x + layout.url.w / 2}
          y={layout.url.y + layout.url.h / 2 + 4}
          textAnchor="middle"
          className="fill-ink text-[11px] font-bold"
        >
          {MCP_HOST}
        </text>
      </g>

      {layout.sources.map((n) => (
        <NodeBox key={n.name} node={n} small={small} />
      ))}
      {layout.providers.map((p) => (
        <NodeBox key={p.name} node={p} small={small} />
      ))}

      {layout.providers.map((p, i) => (
        <Tag
          key={p.name}
          box={p.tag}
          text={p.cost}
          tone={p.paid ? 'lime' : 'card'}
          appear={
            still
              ? undefined
              : { begin: i * STAGGER - PERIOD * ENTRY, from: 0.6 }
          }
        />
      ))}

      <Tag
        box={layout.denied.tag}
        text="denied · over limit"
        tone="coral"
        appear={still ? undefined : { begin: DENIED_BEGIN, from: 0.45 }}
      />

      {still ? (
        <>
          {layout.still.map(([x, y]) => (
            <rect
              key={`${x}${y}`}
              x={x - 6}
              y={y - 6}
              width={12}
              height={12}
              rx={2}
              className="fill-lime stroke-ink"
              strokeWidth={1.5}
            />
          ))}
          <rect
            x={layout.stillDenied[0] - 6}
            y={layout.stillDenied[1] - 6}
            width={12}
            height={12}
            rx={2}
            className="fill-coral stroke-ink"
            strokeWidth={1.5}
          />
        </>
      ) : (
        <>
          {layout.routes.map((route, i) => (
            <Packet
              key={route.d}
              d={route.d}
              crossing={route}
              begin={i * STAGGER - PERIOD * ENTRY}
            />
          ))}
          <Packet d={layout.denied.d} begin={DENIED_BEGIN} denied />
        </>
      )}
      <g>
        <rect
          x={g.x}
          y={g.y}
          width={g.w}
          height={g.h}
          rx={8}
          className="fill-lime stroke-ink"
          strokeWidth={1.5}
        />
        <g>
          <LogoGlyph
            id="solana"
            x={g.x + 62}
            y={g.y + g.h / 2 - 25}
            size={20}
          />
        </g>
        <text
          x={g.x + 90}
          y={g.y + g.h / 2 - 8}
          className="fill-ink text-[16px] font-bold"
        >
          your wallet
        </text>
        {!still &&
          layout.routes.map((route, i) => (
            <g key={route.d}>
              <rect
                x={g.x - 3}
                y={g.y - 3}
                width={g.w + 6}
                height={g.h + 6}
                rx={11}
                fill="none"
                className="stroke-ink"
                strokeWidth={2}
                opacity={0}
              >
                <animate
                  attributeName="opacity"
                  values="0;0.45;0.45;0;0"
                  keyTimes="0;0.02;0.23;0.25;1"
                  dur={`${PERIOD}s`}
                  begin={`${i * STAGGER}s`}
                  repeatCount="indefinite"
                />
              </rect>
              {CROSSING_MESSAGES.map((message, step) => (
                <g key={message} opacity={0}>
                  <rect
                    x={g.x + 10}
                    y={g.y + g.h / 2 + 3}
                    width={g.w - 20}
                    height={26}
                    className="fill-lime"
                  />
                  <g
                    transform={`translate(${g.x + g.w / 2 - 14 - message.length * 3.3} ${g.y + g.h / 2 + 4})`}
                    fill="none"
                    className="stroke-ink"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path
                      d={
                        [
                          'M3 16a9 9 0 1 1 14 0 M4 10h2 M10 3v2 M16 10h2',
                          'M10 2 18 5v6c0 5-8 9-8 9S2 16 2 11V5Z',
                          'M4 2h12v18l-3-2-3 2-3-2-3 2Z',
                        ][step]
                      }
                    />
                    {step === 0 ? (
                      <path d="M10 12V6">
                        <animateTransform
                          attributeName="transform"
                          type="rotate"
                          values="-55 10 12;35 10 12;35 10 12"
                          keyTimes="0;0.045;1"
                          dur={`${PERIOD}s`}
                          begin={`${i * STAGGER + PERIOD * step * PHASE}s`}
                          repeatCount="indefinite"
                        />
                      </path>
                    ) : (
                      <path
                        d={
                          step === 1
                            ? 'M6 10l3 3 5-6'
                            : 'M7 7h6 M7 11h6 M7 15h3'
                        }
                        pathLength={1}
                        strokeDasharray={1}
                      >
                        <animate
                          attributeName="stroke-dashoffset"
                          values="1;0;0"
                          keyTimes="0;0.045;1"
                          dur={`${PERIOD}s`}
                          begin={`${i * STAGGER + PERIOD * step * PHASE}s`}
                          repeatCount="indefinite"
                        />
                      </path>
                    )}
                  </g>
                  <text
                    x={g.x + g.w / 2 + 14}
                    y={g.y + g.h / 2 + 20}
                    textAnchor="middle"
                    textLength={message.length * 6.6}
                    lengthAdjust="spacingAndGlyphs"
                    className="fill-ink text-[11px] font-bold"
                  >
                    {message}
                  </text>
                  <animate
                    attributeName="opacity"
                    values="1;0;0"
                    keyTimes={`0;${PHASE};1`}
                    calcMode="discrete"
                    dur={`${PERIOD}s`}
                    begin={`${i * STAGGER + PERIOD * step * PHASE}s`}
                    repeatCount="indefinite"
                  />
                </g>
              ))}
            </g>
          ))}
      </g>
      {layout.marks.map((at, i) => (
        <Mark key={i} at={at} n={i + 1} />
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

const STEPS = [
  {
    title: 'Every agent connects once.',
    body: `Connect Cursor, Claude, Codex, Grok bot, and MCP-compatible harnesses such as OpenClaw and Hermes through ${MCP_HOST}. No wallet keys live in their configs.`,
  },
  {
    title: 'Your wallet checks the call.',
    body: 'Is this agent allowed to pay? Does the price fit its limit? If either answer is no, the call stops here and nothing is paid.',
  },
  {
    title: 'It pays, forwards, and logs.',
    body: 'The wallet pays the provider and the result comes back through the same connection. The call, its cost, and what is left of the limit go in the activity log.',
  },
]

export function Flow() {
  const reduced = useReducedMotion()
  const { ref, wide } = useWideLayout()
  return (
    <figure className="box box-lg m-0 overflow-hidden">
      <figcaption className="flex flex-wrap items-center justify-between gap-3 border-b-[1.5px] border-ink bg-paper px-4 py-2.5 text-[12px] text-mute">
        <span className="font-semibold text-ink">how a call moves</span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-[2px] border border-ink bg-lime"
            />
            a call from an agent
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block size-2.5 rounded-[2px] border border-ink bg-coral"
            />
            stopped at the limit
          </span>
        </span>
      </figcaption>
      <div ref={ref} className={wide ? 'px-4 py-6 sm:px-6' : 'px-3 py-5'}>
        <Diagram layout={wide ? WIDE : TALL} still={reduced} />
      </div>
      <ol className="grid border-t-[1.5px] border-ink bg-paper sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex gap-3 border-rule px-4 py-4 not-last:border-b sm:px-5 sm:not-last:border-r sm:not-last:border-b-0"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold text-lime">
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[14.5px] leading-snug font-bold tracking-tight text-ink">
                {step.title}
              </span>
              <span className="mt-1 block text-[13px] leading-relaxed text-mute">
                {step.body}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  )
}
