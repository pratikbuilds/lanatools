import {
  MotionConfig,
  motion,
  useMotionValueEvent,
  useScroll,
} from 'motion/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { BeforeAfter } from '#/components/landing/before-after'
import { Wordmark } from '#/components/landing/brand'
import { Flow } from '#/components/landing/flow'
import { EarlyAccess } from '#/components/landing/early-access'
import { Footer } from '#/components/landing/footer'
import { UrlBox } from '#/components/landing/copy-url'
import { Playground } from '#/components/landing/playground'
import { EASE, Reveal } from '#/components/landing/reveal'
import { Toolset } from '#/components/landing/toolset'
import { WalletFan } from '#/components/landing/wallet-fan'

const col = 'mx-auto w-full max-w-[60rem] px-5 sm:px-8'
const wide = 'mx-auto w-full max-w-[76rem] px-5 sm:px-8'

// A solid block that sweeps in behind a word when it scrolls into view.
function Sweep({
  children,
  tone = 'lime',
}: {
  children: ReactNode
  tone?: 'lime' | 'blue'
}) {
  return (
    <span className="relative inline-block px-[0.22em]">
      <motion.span
        aria-hidden="true"
        className={`absolute inset-0 origin-left rounded-[4px] ${
          tone === 'lime' ? 'bg-lime' : 'bg-blue'
        }`}
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, margin: '0px 0px -15% 0px' }}
        transition={{ duration: 0.55, ease: EASE, delay: 0.15 }}
      />
      <span
        className={`relative ${tone === 'lime' ? 'text-ink' : 'text-paper'}`}
      >
        {children}
      </span>
    </span>
  )
}

function Header() {
  const { scrollY } = useScroll()
  const [scrolled, setScrolled] = useState(false)
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 12))

  return (
    <header
      className={`sticky top-0 z-40 transition-colors duration-300 ${
        scrolled ? 'bg-blue-deep/95 backdrop-blur-sm' : 'bg-blue'
      }`}
    >
      <div className={wide}>
        <div
          className={`flex h-16 items-center justify-between border-b-[1.5px] transition-colors duration-300 ${
            scrolled ? 'border-transparent' : 'border-paper/30'
          }`}
        >
          <a href="/" aria-label="lanatools home">
            <span className="max-sm:[&_svg]:size-6 max-sm:[&>span]:gap-1 max-sm:[&>span]:text-[14px]">
              <Wordmark size={32} />
            </span>
          </a>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-6 text-[13.5px] text-paper-2 md:flex"
          >
            <a href="#why" className="hover:text-paper">
              Why
            </a>
            <a href="#how" className="hover:text-paper">
              How it works
            </a>
            <a href="#control" className="hover:text-paper">
              Control
            </a>
            <a href="#tools" className="hover:text-paper">
              Tools
            </a>
          </nav>
          <a href="/sign-in" className="btn btn-sm btn-primary">
            Sign in
          </a>
        </div>
      </div>
    </header>
  )
}

const CONNECT_STEPS = [
  'Create an account and fund the wallet.',
  'Paste the URL into Cursor, Claude, Codex, or any MCP client.',
  'Approve that client’s permissions and limit at sign-in.',
]

function Hero() {
  return (
    <section className={`${wide} overflow-x-clip py-12 sm:py-16 lg:py-20`}>
      <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
        <div>
          <h1 className="display text-[clamp(2.2rem,4.5vw,3.5rem)]">
            Connect your agent
            <br />
            <span className="text-lime">to everything on Solana.</span>
          </h1>
          <div className="mt-6 max-w-[56ch] text-[14px] leading-6 text-paper">
            <p className="font-medium">
              Read onchain data, pay for services, and send transactions through
              one MCP connection.
            </p>
            <p className="mt-3 text-paper-2">
              You control each agent’s permissions and spending limit.
            </p>
          </div>
          {/* .btn is unlayered CSS, so size overrides need !important. */}
          <a
            href="/sign-in"
            className="btn btn-primary group mt-8 h-14! gap-3! px-7! text-[16px]! max-sm:w-full"
          >
            Get started
            <span
              aria-hidden="true"
              className="transition-transform duration-200 ease-(--ease-out) group-hover:translate-x-1"
            >
              →
            </span>
          </a>
        </div>
        <div className="mx-auto w-full max-w-[560px]">
          <WalletFan />
        </div>
      </div>
    </section>
  )
}

export function Home() {
  return (
    <MotionConfig reducedMotion="user">
      <Header />

      <main>
        <Hero />

        <section id="why" className="on-paper bg-paper text-ink">
          <div className={`${wide} py-12 sm:py-16`}>
            <Reveal className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start md:gap-12">
              <h2 className="title text-[clamp(1.25rem,2.2vw,1.75rem)]">
                One connection. Less setup.
              </h2>
              <p className="max-w-[60ch] text-[14px] leading-6 text-mute">
                Keep provider API keys out of agent configs. Manage permissions,
                spending limits, and activity in LanaTools.
              </p>
            </Reveal>
            <div className="mt-8">
              <BeforeAfter />
            </div>
          </div>
        </section>

        <section id="how" className={`${wide} py-16 sm:py-24`}>
          <Reveal>
            <p className="eyebrow text-paper-2">how it works</p>
            <h2 className="title mt-3 max-w-[32ch] text-[clamp(1.6rem,3vw,2.25rem)]">
              Every call runs <Sweep>inside the rules you set.</Sweep>
            </h2>
          </Reveal>
          <Reveal className="mt-10" delay={0.1}>
            <Flow />
          </Reveal>
        </section>

        <section id="control" className="on-paper bg-paper text-ink">
          <div className={`${wide} py-16 sm:py-24`}>
            <Reveal>
              <p className="eyebrow text-mute">control</p>
              <h2 className="title mt-3 text-[clamp(1.6rem,3vw,2.25rem)]">
                You decide what <Sweep tone="blue">each agent can do.</Sweep>
              </h2>
              <p className="mt-5 max-w-[62ch] text-[15.5px] text-mute">
                Try it. Pick an agent and switch off what it shouldn&rsquo;t do.
                Sample calls keep arriving in the activity log, so you can see
                which ones still get through.
              </p>
            </Reveal>
            <Reveal className="mt-10" delay={0.1}>
              <Playground />
            </Reveal>
          </div>
        </section>

        <section id="tools" className={`${wide} py-16 sm:py-24`}>
          <Reveal>
            <p className="eyebrow text-paper-2">tools</p>
            <h2 className="title mt-3 max-w-[34ch] text-[clamp(1.6rem,3vw,2.25rem)]">
              Connect once. It keeps getting <Sweep>more useful.</Sweep>
            </h2>
            <p className="mt-5 max-w-[62ch] text-[15.5px] text-paper-2">
              Payments, onchain data, and transactions through one connection.
              Give your agents the tools to act on Solana, with permissions and
              one limit for each agent.
            </p>
          </Reveal>
          <div className="mt-12">
            <Toolset />
          </div>
        </section>

        <section id="connect" className="on-paper bg-paper text-ink">
          <div className={`${col} py-20 sm:py-28`}>
            <Reveal>
              <p className="eyebrow text-mute">connect</p>
              <h2 className="display mt-3 text-[clamp(2.2rem,5vw,3.5rem)]">
                Paste <Sweep tone="blue">one URL.</Sweep>
              </h2>
            </Reveal>
            <ol className="mt-8 grid gap-3 sm:grid-cols-3">
              {CONNECT_STEPS.map((text, i) => (
                <motion.li
                  key={text}
                  className="flex gap-3 rounded-[8px] border-[1.5px] border-ink bg-card px-4 py-3.5 text-[14px] shadow-[3px_3px_0_0_var(--color-ink)]"
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.45, ease: EASE, delay: 0.08 * i }}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-ink bg-lime text-[11px] font-bold">
                    {i + 1}
                  </span>
                  {text}
                </motion.li>
              ))}
            </ol>
            <Reveal className="mt-8" delay={0.2}>
              <UrlBox />
            </Reveal>
            <Reveal className="mt-14" delay={0.25}>
              <div id="updates" className="scroll-mt-24">
                <p className="eyebrow text-mute">updates</p>
                <h3 className="title mt-3 text-[clamp(1.3rem,2.4vw,1.7rem)]">
                  Follow what we&rsquo;re building.
                </h3>
                <div className="mt-6">
                  <EarlyAccess tone="paper" />
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <Footer wide={wide} />
    </MotionConfig>
  )
}
