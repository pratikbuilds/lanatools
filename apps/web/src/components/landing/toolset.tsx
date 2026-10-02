import { motion } from 'motion/react'
import { Logo } from './logo'
import { EASE } from './reveal'

type Stage = 'available' | 'next' | 'planned'

const TOOLS: Array<{
  stage: Stage
  title: string
  body: string
  icon: string
  solana?: boolean
}> = [
  {
    stage: 'available',
    title: 'Pay for services',
    icon: '/lanatools-icon-pay.png',
    body: 'Discover paid services in the catalog and let your agent pay for what it needs within the permissions and limit you set for that agent.',
  },
  {
    stage: 'next',
    title: 'Ask for a result, skip the setup',
    icon: '/lanatools-icon-route.png',
    body: 'Ask for a paid result and let the router reach the right provider, without finding and configuring each URL yourself.',
  },
  {
    stage: 'planned',
    title: 'Create and execute transactions',
    icon: '/lanatools-icon-prepare.png',
    body: 'Create Solana transactions and execute them through your embedded wallet within the permissions you grant, or sign with your own wallet and let LanaTools submit them.',
  },
  {
    stage: 'planned',
    title: 'Read Solana',
    icon: '/lanatools-icon-read.png',
    solana: true,
    body: 'Read onchain data, explore portfolios, and query activity through the same connection your agent uses to take action.',
  },
]

const CHIP: Record<Stage, { text: string; className: string }> = {
  available: { text: 'first at launch', className: 'chip chip-lime' },
  next: { text: 'next', className: 'chip chip-blue' },
  planned: { text: 'planned', className: 'chip' },
}

export function Toolset() {
  return (
    <div>
      <div className="relative mb-8 hidden h-6 lg:block" aria-hidden="true">
        <div className="absolute inset-x-[12.5%] top-1/2 border-t-[1.5px] border-dashed border-paper/40" />
        <motion.div
          className="absolute top-1/2 left-[12.5%] border-t-[1.5px] border-lime"
          initial={{ width: 0 }}
          whileInView={{ width: '25%' }}
          viewport={{ once: true }}
          transition={{ duration: 1, ease: EASE, delay: 0.3 }}
        />
        {TOOLS.map((t, i) => (
          <motion.span
            key={t.title}
            className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-[1.5px] ${
              t.stage === 'available'
                ? 'border-ink bg-lime'
                : t.stage === 'next'
                  ? 'border-paper bg-blue'
                  : 'border-paper/50 bg-blue'
            }`}
            style={{ left: `${12.5 + i * 25}%` }}
            initial={{ scale: 0 }}
            whileInView={{ scale: 1 }}
            viewport={{ once: true }}
            transition={{ type: 'spring', bounce: 0.5, delay: 0.2 + i * 0.12 }}
          />
        ))}
      </div>
      <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {TOOLS.map((tool, i) => {
          const chip = CHIP[tool.stage]
          const live = tool.stage === 'available'
          return (
            <motion.li
              key={tool.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '0px 0px -10% 0px' }}
              transition={{ duration: 0.55, ease: EASE, delay: i * 0.1 }}
              whileHover={{ y: -4 }}
              className={`flex flex-col rounded-[10px] p-5 text-ink ${
                live
                  ? 'border-[1.5px] border-ink bg-lime shadow-[6px_6px_0_0_var(--color-ink)]'
                  : 'border-[1.5px] border-dashed border-paper/60 bg-card/95'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <img
                  src={tool.icon}
                  alt=""
                  width={52}
                  height={52}
                  loading="lazy"
                  className={`size-13 rounded-[8px] border-[1.5px] border-ink ${live ? '' : 'opacity-80 grayscale-[35%]'}`}
                />
                <span className={chip.className}>{chip.text}</span>
              </div>
              <h3 className="mt-5 flex items-center gap-2 text-[17px] font-bold tracking-tight">
                {tool.solana && <Logo id="solana" size={16} />}
                {tool.title}
              </h3>
              <p
                className={`mt-2 text-[13.5px] ${live ? 'text-ink/80' : 'text-mute'}`}
              >
                {tool.body}
              </p>
            </motion.li>
          )
        })}
      </ol>
    </div>
  )
}
