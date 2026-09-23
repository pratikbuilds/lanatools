import { motion } from 'motion/react'
import { EASE } from './reveal'

// "Open port": the MCP connection your agents plug into, and a prompt with
// a live cursor for the agent at work.
export const PORT =
  'M16 56h-4q-4 0-4-4V15q0-7 7-7h23l19 12.5V29L37 16H19.5q-3.5 0-3.5 3.5Z'
export const PROMPT = 'M23 26l8 7-8 7'

export function BrandMark({
  size = 28,
  animate = false,
}: {
  size?: number
  animate?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      <motion.path
        d={PORT}
        fill="currentColor"
        initial={animate ? { opacity: 0, scale: 0.85 } : false}
        animate={{ opacity: 1, scale: 1 }}
        style={{ transformOrigin: '12px 56px' }}
        transition={{ duration: 0.5, ease: EASE }}
      />
      <motion.path
        d={PROMPT}
        fill="none"
        stroke="currentColor"
        strokeWidth={4.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={animate ? { x: -8, opacity: 0 } : false}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: EASE, delay: 0.3 }}
      />
      <g className={animate ? 'caret-late' : undefined}>
        <motion.rect
          x={35}
          y={41}
          width={15}
          height={5}
          rx={2.5}
          className="fill-lime"
          initial={animate ? { scaleX: 0 } : false}
          animate={{ scaleX: 1 }}
          style={{ originX: 0 }}
          transition={{ duration: 0.4, ease: EASE, delay: 0.6 }}
        />
      </g>
    </svg>
  )
}

export function Wordmark({
  size = 28,
  animate = false,
}: {
  size?: number
  animate?: boolean
}) {
  return (
    <span className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
      <BrandMark size={size} animate={animate} />
      <span>
        lanatools<span className="font-medium text-paper-2">.sh</span>
      </span>
    </span>
  )
}
