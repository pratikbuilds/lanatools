import { createFileRoute } from '@tanstack/react-router'
import { ApiStatus } from '#/components/landing/api-status'
import { UrlBox } from '#/components/landing/copy-url'
import { Flow } from '#/components/landing/flow'
import { Logo } from '#/components/landing/logo'
import type { AgentId } from '#/components/landing/logos'

export const Route = createFileRoute('/')({ component: Home })

type Stage = 'available' | 'next' | 'planned'

const TOOLS: Array<{
  stage: Stage
  title: string
  body: string
  solana?: boolean
}> = [
  {
    stage: 'available',
    title: 'Pay for services',
    body: 'Paid endpoints, including ones found through the pay.sh catalog, settle from your wallet within that client’s limit. A failed or unclear payment is checked before anything is charged twice.',
  },
  {
    stage: 'next',
    title: 'Route payment URLs',
    body: 'Ask for a paid result and let the router reach the right provider. You should not have to find and configure each URL yourself.',
  },
  {
    stage: 'planned',
    title: 'Prepare transactions',
    body: 'Swaps and transfers are built by the service and returned as a review link. You sign from a local wallet, a browser wallet, or the embedded wallet.',
  },
  {
    stage: 'planned',
    title: 'Read Solana',
    solana: true,
    body: 'Accounts, transactions, markets, and analytics from Helius, Jupiter, and Dune. The credits each provider reports show up next to your payments.',
  },
]

function stageChip(stage: Stage) {
  switch (stage) {
    case 'available':
      return { text: 'available now', className: 'chip chip-lime' }
    case 'next':
      return { text: 'next', className: 'chip chip-blue' }
    case 'planned':
      return { text: 'planned', className: 'chip' }
    default: {
      const exhaustive: never = stage
      return exhaustive
    }
  }
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})
const whole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const LIMITS: Array<{
  id: AgentId
  name: string
  kind: string
  cap: number
  spent: number
  can: Array<string>
}> = [
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'desktop',
    cap: 25,
    spent: 6.63,
    can: ['read', 'pay', 'prepare'],
  },
  {
    id: 'claude',
    name: 'Claude',
    kind: 'desktop',
    cap: 10,
    spent: 1.2,
    can: ['read', 'prepare'],
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'desktop · cloud',
    cap: 15,
    spent: 4.5,
    can: ['read', 'pay'],
  },
  {
    id: 'grok',
    name: 'Grok',
    kind: 'cloud',
    cap: 8,
    spent: 0.4,
    can: ['read'],
  },
  {
    id: 'cloud',
    name: 'Cloud agent',
    kind: 'server',
    cap: 5,
    spent: 5,
    can: ['read', 'pay'],
  },
]

const STEPS = [
  { text: 'Your agent asks for an allowed paid endpoint.' },
  {
    text: 'We compare the price with that client’s remaining limit and permissions.',
  },
  {
    text: 'We pay from the embedded wallet and forward the call.',
    chip: 'or deny it here',
  },
  { text: 'The result comes back through the same connection.' },
  {
    text: 'Call, cost, result, and what is left of the limit go on the record.',
  },
]

const col = 'mx-auto w-full max-w-[60rem] px-5 sm:px-8'
const wide = 'mx-auto w-full max-w-[76rem] px-5 sm:px-8'

function Home() {
  return (
    <>
      <header className={col}>
        <div className="flex h-16 items-center justify-between border-b-[1.5px] border-paper/30">
          <a href="/" className="text-[17px] font-bold tracking-tight">
            lanatools
          </a>
          <nav
            aria-label="Primary"
            className="hidden items-center gap-6 text-[13.5px] text-paper-2 md:flex"
          >
            <a href="#does" className="hover:text-paper">
              What it does
            </a>
            <a href="#limits" className="hover:text-paper">
              Limits
            </a>
            <a href="#how" className="hover:text-paper">
              How a call works
            </a>
          </nav>
          <a href="#connect" className="btn btn-sm btn-primary">
            Connect an agent
          </a>
        </div>
      </header>

      <main>
        <section className={`${col} pt-14 pb-16 sm:pt-20`}>
          <h1 className="display text-[clamp(2.25rem,5.4vw,3.75rem)]">
            One MCP server for <span className="hl">agents</span> on{' '}
            <span className="inline-flex items-center gap-[0.18em] whitespace-nowrap align-[-0.08em]">
              <Logo id="solana" className="h-[0.72em] w-[0.72em] text-lime" />
              Solana.
            </span>
          </h1>
          <p className="mt-6 max-w-[62ch] text-[16.5px] text-paper-2">
            Cursor, Claude, Codex, Grok, and a cloud agent share one URL and one
            wallet. Each client gets its own permissions and spending limit.
            Every call is on the record.
          </p>
          <ul className="mt-8 flex flex-wrap gap-2">
            {LIMITS.map((agent) => (
              <li key={agent.id}>
                <span className="chip gap-1.5">
                  <Logo id={agent.id} size={14} />
                  {agent.name}
                </span>
              </li>
            ))}
          </ul>
          {/* <Install /> is ready for the client setup launch. */}
          <p className="mt-6 flex flex-wrap items-center gap-3 text-[13.5px] text-paper-2">
            <span className="chip chip-lime">available now</span>
            <a href="#does" className="arrow-link text-paper">
              Paid endpoints through pay.sh. Routing, transactions, and data
              next
            </a>
          </p>
        </section>

        <section className={`${wide} pb-20 sm:pb-24`}>
          <Flow />
        </section>

        <section id="does" className="on-paper bg-paper text-ink">
          <div className={`${col} py-16 sm:py-20`}>
            <p className="eyebrow text-mute">what it does</p>
            <h2 className="title mt-3 text-[clamp(1.6rem,3vw,2.125rem)]">
              <span className="hl-blue">Pays</span> for services today. Routes,
              prepares, and reads next.
            </h2>
            <ol className="box box-lg mt-10 overflow-hidden">
              {TOOLS.map((tool, i) => {
                const chip = stageChip(tool.stage)
                const lead = tool.stage === 'available'
                return (
                  <li
                    key={tool.title}
                    className={`grid gap-3 border-b border-rule px-5 py-5 last:border-b-0 sm:grid-cols-[4.5rem_9rem_minmax(0,1fr)] sm:items-baseline sm:gap-6 ${
                      lead ? 'bg-lime/40' : 'bg-card'
                    }`}
                  >
                    <span className="font-bold text-mute">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={`${chip.className} self-start sm:self-auto`}
                    >
                      {chip.text}
                    </span>
                    <div>
                      <h3 className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
                        {tool.solana && <Logo id="solana" size={16} />}
                        {tool.title}
                      </h3>
                      <p className="mt-1.5 max-w-[62ch] text-[14.5px] text-mute">
                        {tool.body}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        </section>

        <section id="limits" className={`${col} py-16 sm:py-20`}>
          <p className="eyebrow text-paper-2">limits</p>
          <h2 className="title mt-3 text-[clamp(1.6rem,3vw,2.125rem)]">
            Every client. One wallet. <span className="hl">Its own limit.</span>
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15.5px] text-paper-2">
            Each client has its own permissions and monthly limit. Every paid
            call is checked against what that client has left. Raise a limit or
            revoke a client whenever you like; what it already spent stays on
            the record.
          </p>
          <div className="box box-lg mt-10 overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1.4fr)_7rem_7rem_minmax(8rem,1fr)] gap-4 border-b border-rule bg-paper px-4 py-2 text-[11px] font-semibold tracking-wide text-mute uppercase sm:grid">
              <span>Client</span>
              <span className="text-right">Spent</span>
              <span className="text-right">Limit</span>
              <span>Used</span>
            </div>
            <ul>
              {LIMITS.map((c) => {
                const ratio = Math.min(c.spent / c.cap, 1)
                const full = ratio >= 1
                return (
                  <li
                    key={c.id}
                    className="grid gap-3 border-b border-rule px-4 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_7rem_7rem_minmax(8rem,1fr)] sm:items-center sm:gap-4"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex size-9 items-center justify-center rounded-[6px] border border-ink bg-card">
                        <Logo id={c.id} size={18} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[15px] font-bold">{c.name}</p>
                        <p className="text-[12px] text-mute">
                          {c.kind} · {c.can.join(' · ')}
                        </p>
                      </div>
                    </div>
                    <p
                      className={`font-bold sm:text-right ${full ? 'text-coral' : ''}`}
                    >
                      <span className="mr-2 text-[11px] font-semibold tracking-wide text-mute uppercase sm:hidden">
                        Spent
                      </span>
                      {usd.format(c.spent)}
                    </p>
                    <p className="text-mute sm:text-right">
                      <span className="mr-2 text-[11px] font-semibold tracking-wide text-mute uppercase sm:hidden">
                        Limit
                      </span>
                      {whole.format(c.cap)}
                    </p>
                    <div>
                      <div
                        role="meter"
                        aria-label={`${c.name} spending`}
                        aria-valuemin={0}
                        aria-valuemax={c.cap}
                        aria-valuenow={c.spent}
                        className="h-2.5 w-full overflow-hidden rounded-[3px] border border-ink bg-card"
                      >
                        <div
                          className={`h-full ${full ? 'bg-coral' : 'bg-blue'}`}
                          style={{ width: `${Math.max(ratio * 100, 2)}%` }}
                        />
                      </div>
                      {full && (
                        <p className="mt-1.5 text-[12px] font-semibold text-coral">
                          limit reached · paid calls denied
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
          <p className="mt-6 text-[12.5px] text-paper-3">
            illustrative figures
          </p>
        </section>

        <section id="how" className="on-paper bg-paper text-ink">
          <div className={`${col} py-16 sm:py-20`}>
            <p className="eyebrow text-mute">how a paid call works</p>
            <h2 className="title mt-3 text-[clamp(1.6rem,3vw,2.125rem)]">
              Money moves inside the rules you set.{' '}
              <span className="hl-blue">Never twice</span> for one unclear
              payment.
            </h2>
            <ol className="box box-lg mt-10 overflow-hidden">
              {STEPS.map((step, i) => (
                <li
                  key={step.text}
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)] border-b border-rule last:border-b-0"
                >
                  <span className="flex items-center justify-center border-r border-rule bg-paper text-[15px] font-bold">
                    {i + 1}
                  </span>
                  <p className="flex flex-wrap items-center gap-3 px-5 py-4 text-[15px]">
                    {step.text}
                    {step.chip && (
                      <span className="chip chip-coral">{step.chip}</span>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="connect" className={`${col} py-16 sm:py-24`}>
          <p className="eyebrow text-paper-2">connect</p>
          <h2 className="display mt-3 text-[clamp(2rem,4.5vw,3.25rem)]">
            Paste <span className="hl">one URL.</span>
          </h2>
          <p className="mt-5 max-w-[60ch] text-[15.5px] text-paper-2">
            Create an account, fund the wallet, paste the URL into a client you
            already use. Sign-in sets that client’s permissions and limit. Add a
            second client with a different limit whenever you want.
          </p>
          <div className="mt-8">
            <UrlBox />
          </div>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#connect" className="btn btn-primary">
              Create account
            </a>
            <a href="#how" className="btn">
              How a call works →
            </a>
          </div>
        </section>
      </main>

      <footer className="bg-blue-deep">
        <div
          className={`${col} flex flex-wrap items-center justify-between gap-4 py-6`}
        >
          <p className="text-[14px] font-bold tracking-tight">lanatools</p>
          <ApiStatus />
        </div>
      </footer>
    </>
  )
}
