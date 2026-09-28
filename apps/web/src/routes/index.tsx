import { createFileRoute } from '@tanstack/react-router'
import {
  MotionConfig,
  motion,
  useMotionValueEvent,
  useScroll,
} from 'motion/react'
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { BeforeAfter } from '#/components/landing/before-after'
import { Wordmark } from '#/components/landing/brand'
import { Flow } from '#/components/landing/flow'
import { EarlyAccess } from '#/components/landing/early-access'
import { Footer } from '#/components/landing/footer'
import { UrlBox } from '#/components/landing/copy-url'
import { Logo } from '#/components/landing/logo'
import { Playground } from '#/components/landing/playground'
import { EASE, Reveal } from '#/components/landing/reveal'
import { Toolset } from '#/components/landing/toolset'
import { WalletFan } from '#/components/landing/wallet-fan'

export const Route = createFileRoute('/')({ component: Home })

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
            <Wordmark size={32} animate />
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
          <a href="#early-access" className="btn btn-sm btn-primary">
            Get early access
          </a>
        </div>
      </div>
    </header>
  )
}

const HEADLINE = ['Let', 'your', 'agents', 'pay.']

const CONNECT_STEPS = [
  'Create an account and fund the wallet.',
  'Paste the URL into Cursor, Claude, Codex, or any MCP client.',
  'Approve that client’s permissions and limit at sign-in.',
]

function Hero() {
  return (
    <section className={`${wide} pt-12 pb-14 sm:pt-16 lg:pt-20`}>
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-14">
        <div>
          <motion.span
            className="chip gap-1.5"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <Logo id="solana" size={12} />
            the wallet for your agents · on Solana
          </motion.span>
          {/* Real spaces between the words keep the text readable; the
              negative word-spacing keeps the gap tight like the design. */}
          <h1 className="display mt-6 text-[clamp(2.4rem,6vw,4.1rem)] [word-spacing:-0.28em]">
            {HEADLINE.map((word, i) => (
              <Fragment key={word}>
                <motion.span
                  className="inline-block"
                  initial={{ opacity: 0, y: '0.5em' }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.55,
                    ease: EASE,
                    delay: 0.08 + i * 0.07,
                  }}
                >
                  {word}
                </motion.span>{' '}
              </Fragment>
            ))}
            <br />
            <motion.span
              className="relative inline-block px-[0.2em] [word-spacing:normal]"
              initial={{ opacity: 0, y: '0.5em' }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE, delay: 0.4 }}
            >
              <motion.span
                aria-hidden="true"
                className="absolute inset-0 origin-left rounded-[5px] bg-lime"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.6, ease: EASE, delay: 0.7 }}
              />
              <span className="relative text-ink">Within limits.</span>
            </motion.span>
          </h1>
          <motion.p
            className="mt-7 max-w-[54ch] text-[16px] text-paper-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.6 }}
          >
            Give Cursor, Claude, Codex, Grok, and your cloud agents one wallet
            you own. They buy the APIs and data they need. You set what each one
            can spend, and no keys ever sit in their configs.
          </motion.p>
          <motion.div
            className="mt-8"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.75 }}
          >
            <EarlyAccess tone="blue" />
          </motion.div>
        </div>
        <div className="mx-auto w-full max-w-[560px]">
          <WalletFan />
        </div>
      </div>
    </section>
  )
}

function Home() {
  return (
    <MotionConfig reducedMotion="user">
      <Header />

      <main>
        <Hero />

        <section id="why" className="on-paper bg-paper text-ink">
          <div className={`${wide} py-16 sm:py-24`}>
            <Reveal>
              <p className="eyebrow text-mute">why</p>
              <h2 className="title mt-3 max-w-[30ch] text-[clamp(1.6rem,3vw,2.25rem)]">
                Stop pasting keys into <Sweep tone="blue">every agent.</Sweep>
              </h2>
              <p className="mt-5 max-w-[62ch] text-[15.5px] text-mute">
                Today, each agent needs its own key and its own setup for every
                paid service, and every copy is a key that can leak. With
                LanaTools, each agent connects once and your keys stay in your
                wallet.
              </p>
            </Reveal>
            <div className="mt-12">
              <BeforeAfter />
            </div>
          </div>
        </section>

        <section id="how" className={`${wide} py-16 sm:py-24`}>
          <Reveal>
            <p className="eyebrow text-paper-2">how it works</p>
            <h2 className="title mt-3 max-w-[32ch] text-[clamp(1.6rem,3vw,2.25rem)]">
              Money moves only <Sweep>inside the rules you set.</Sweep>
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
                Cut off any agent <Sweep tone="blue">in one click.</Sweep>
              </h2>
              <p className="mt-5 max-w-[62ch] text-[15.5px] text-mute">
                Try it. Pick an agent, then raise its limit, revoke it, or send
                a test call. Every change shows up in the activity log next to
                the calls it affects. The numbers here are samples.
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
              Paid APIs come first. Routing, swaps you sign yourself, and Solana
              data from Helius, Jupiter, and Dune follow, all through the URL
              you already added.
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
              <div id="early-access" className="scroll-mt-24">
                <p className="eyebrow text-mute">early access</p>
                <h3 className="title mt-3 text-[clamp(1.3rem,2.4vw,1.7rem)]">
                  Be first to give your agents a wallet.
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
