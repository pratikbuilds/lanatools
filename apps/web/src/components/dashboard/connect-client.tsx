import { useState } from 'react'
import {
  CLIENTS,
  CopyStatus,
  MCP_URL,
  SKILL_URL,
  copyLabel,
  useCopy,
} from '#/components/landing/copy-url'
import { Logo } from '#/components/landing/logo'
import { AGENTS } from '#/components/landing/logos'
import type { AgentId } from '#/components/landing/logos'
import { Modal } from './modal'

/**
 * The clients in the order the dashboard offers them, each with where it
 * runs: the landing page's labels are shorter, for its illustrations.
 */
const CLIENT_CARDS: ReadonlyArray<{ id: AgentId; kind: string }> = [
  { id: 'grok', kind: 'agent' },
  { id: 'codex', kind: 'cli · desktop · cloud' },
  { id: 'claude', kind: 'cli · desktop · web' },
  { id: 'cursor', kind: 'desktop' },
  { id: 'others', kind: 'OpenClaw · Hermes' },
]
export const DEFAULT_CLIENT: AgentId = 'grok'

/** Adds LanaTools to Cursor in one click; the config rides in the link. */
export const CURSOR_INSTALL_URL = `cursor://anysphere.cursor-deeplink/mcp/install?name=lanatools&config=${btoa(
  JSON.stringify({ url: MCP_URL }),
)}`

type Setup = {
  /** What to do with the snippet. */
  lead: string
  /** What is copied: a command, a config block or the bare URL. */
  snippet: string
  /** What the client does next. */
  then: string
  /** The same client in another form, when its setup differs. */
  aside?: string
}

// The snippets are the landing page's, so both places stay in step.
function snippetOf(id: AgentId) {
  return CLIENTS[id].lines.join('\n').replace(/^\$ /, '')
}

const SETUPS: Record<AgentId, Setup> = {
  claude: {
    lead: 'Run this in a terminal to add LanaTools to Claude Code.',
    snippet: snippetOf('claude'),
    then: 'Start claude. Its first call to LanaTools opens your browser to approve the client. If nothing opens, run /mcp.',
    aside: `Using the Claude app or claude.ai instead? Go to Settings, then Connectors, and add a custom connector with ${MCP_URL} as its URL.`,
  },
  cursor: {
    lead: `Or add this to ${CLIENTS.cursor.file} by hand.`,
    snippet: snippetOf('cursor'),
    then: 'Cursor lists LanaTools under MCP. Turn it on, and approve the client when your browser opens.',
  },
  codex: {
    lead: 'Run this in a terminal to add LanaTools to Codex.',
    snippet: snippetOf('codex'),
    then: 'Run codex mcp login lanatools, or start codex. It opens your browser to approve the client.',
    aside: `By hand instead? Add [mcp_servers.lanatools] with url = "${MCP_URL}" to ~/.codex/config.toml.`,
  },
  grok: {
    lead: 'Paste the skill into a chat with Grok bot.',
    snippet: SKILL_URL,
    then: 'It reads the skill, connects, and opens your browser to approve it.',
    aside: `An agent with MCP settings takes ${MCP_URL} directly.`,
  },
  others: {
    lead: 'Paste the skill into a chat with the agent.',
    snippet: SKILL_URL,
    then: 'It reads the skill, connects, and opens your browser to approve it.',
    aside: `A client with MCP settings takes ${MCP_URL} directly.`,
  },
}

/**
 * The setup for a new client, centred over the page: pick the client on
 * the left, follow its steps on the right.
 */
export function ConnectClientModal({
  client,
  onClose,
}: {
  /** The client to start on; closed when there is none. */
  client: AgentId | null
  onClose: () => void
}) {
  return (
    <Modal
      open={client !== null}
      onClose={onClose}
      title="Connect a client"
      detail="One URL for every MCP client"
      size="lg"
    >
      <ConnectClient initial={client ?? DEFAULT_CLIENT} />
    </Modal>
  )
}

/** How to add LanaTools to an AI client: pick the client, then follow its steps. */
export function ConnectClient({
  initial = DEFAULT_CLIENT,
}: {
  initial?: AgentId
}) {
  const [id, setId] = useState<AgentId>(initial)
  return (
    <div className="grid gap-6 md:h-full md:grid-cols-[13.5rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:gap-7">
      <div role="group" aria-label="Your client" className="md:self-start">
        <p className="d-label">Pick your client</p>
        <ul className="mt-3 grid grid-cols-2 gap-1.5 md:grid-cols-1">
          {CLIENT_CARDS.map((agent) => (
            <li key={agent.id}>
              <ClientCard
                id={agent.id}
                pressed={agent.id === id}
                onClick={() => setId(agent.id)}
              />
            </li>
          ))}
        </ul>
      </div>
      {/* Fresh for each client, so a copy made for one is not shown on another. */}
      <ClientSteps key={id} id={id} />
    </div>
  )
}

/** The numbered steps for one client, with the one thing to copy. */
function ClientSteps({ id }: { id: AgentId }) {
  const setup = SETUPS[id]
  const { state, copy } = useCopy(setup.snippet)
  const steps = [
    ...(id === 'cursor' ? [<CursorInstall key="install" />] : []),
    <Snippet
      key="snippet"
      lead={setup.lead}
      snippet={setup.snippet}
      copied={copyLabel(state, 'Copy')}
      onCopy={() => void copy()}
    />,
    <p key="then" className="text-[13px] text-fg-2">
      {setup.then}
    </p>,
  ]

  return (
    <div className="min-w-0 md:min-h-0 md:overflow-y-auto md:pr-1">
      <p className="d-label">{`Set up ${nameOf(id)}`}</p>
      <ol className="mt-3 grid gap-4">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full border border-line bg-panel-2 font-mono text-[11px] font-semibold text-fg-2"
            >
              {index + 1}
            </span>
            <div className="min-w-0">{step}</div>
          </li>
        ))}
      </ol>
      <CopyStatus state={state} subject="setup" />
      {setup.snippet !== SKILL_URL && <SkillPrompt name={nameOf(id)} />}
      {setup.aside && (
        <p className="mt-5 border-t border-dashed border-line-2 pt-4 text-[12.5px] text-fg-3">
          {setup.aside}
        </p>
      )}
      <p className="mt-5 flex items-start gap-2.5 rounded-[10px] border border-line bg-surface px-3.5 py-3 text-[12.5px] text-fg-2">
        <span
          aria-hidden="true"
          className="mt-[3px] h-2 w-2 shrink-0 rounded-full bg-live"
        />
        <span>
          When you approve the client, you set its spending limit. It then
          appears under Connected clients.
        </span>
      </p>
    </div>
  )
}

function nameOf(id: AgentId) {
  return AGENTS.find((each) => each.id === id)?.name
}

/** The skill as the other way in: paste its URL, and the client sets itself up. */
function SkillPrompt({ name }: { name: string | undefined }) {
  const { state, copy } = useCopy(SKILL_URL)
  return (
    <div className="mt-5 border-t border-dashed border-line-2 pt-4">
      <Snippet
        lead={`Or paste the skill into a chat with ${name}.`}
        snippet={SKILL_URL}
        copied={copyLabel(state, 'Copy')}
        onCopy={() => void copy()}
      />
      <CopyStatus state={state} subject="skill URL" />
    </div>
  )
}

function CursorInstall() {
  return (
    <div>
      <p className="text-[13px] text-fg-2">
        Install it in Cursor with one click.
      </p>
      <a href={CURSOR_INSTALL_URL} className="d-btn d-btn-primary mt-2">
        <ClientLogo id="cursor" size={14} />
        Install in Cursor
      </a>
    </div>
  )
}

function Snippet({
  lead,
  snippet,
  copied,
  onCopy,
}: {
  lead: string
  snippet: string
  copied: string
  onCopy: () => void
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-fg-2">{lead}</p>
        <button
          type="button"
          className="d-btn d-btn-sm -mt-1 shrink-0"
          onClick={onCopy}
        >
          {copied}
        </button>
      </div>
      <pre className="d-well mt-2 text-[12.5px] leading-5 whitespace-pre-wrap">
        {snippet}
      </pre>
    </div>
  )
}

/**
 * A client as a tile: its mark, its name and where it runs. Pressed when
 * it is the one being set up.
 */
export function ClientCard({
  id,
  pressed,
  onClick,
}: {
  id: AgentId
  pressed?: boolean
  onClick: () => void
}) {
  const kind = CLIENT_CARDS.find((each) => each.id === id)?.kind
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border border-line bg-panel px-2.5 py-2 text-left hover:border-line-2 aria-pressed:border-accent aria-pressed:bg-surface"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel-2 text-fg">
        <ClientLogo id={id} size={16} />
      </span>
      <span className="min-w-0">
        <b className="block text-[13px] leading-tight font-semibold">
          {nameOf(id)}
        </b>
        <span className="mt-0.5 block font-mono text-[11px] text-fg-3">
          {kind}
        </span>
      </span>
    </button>
  )
}

/** A client's mark in the page's ink, except Claude, whose mark is its colour. */
function ClientLogo({ id, size }: { id: AgentId; size: number }) {
  return (
    <Logo
      id={id}
      size={size}
      {...(id === 'claude' ? {} : { color: 'currentColor' })}
    />
  )
}

/**
 * The Connected clients section before any client exists: what connecting
 * means, and the clients to pick from, in place of an empty table.
 */
export function ConnectFirstClient({
  onConnect,
}: {
  onConnect: (client: AgentId) => void
}) {
  return (
    <div className="d-frame">
      <div className="d-inset grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="d-pane">
          <p className="d-label">No clients yet</p>
          <h3 className="mt-3 font-mono text-[1.25rem] font-semibold tracking-[-0.03em]">
            Connect your first client
          </h3>
          <p className="mt-2 max-w-[30rem] text-fg-2">
            Give Grok bot, Codex, Claude, Cursor or any MCP client one URL, or
            let it set itself up from the skill. You approve each one and give
            it its own spending limit, and it appears here.
          </p>
          <button
            type="button"
            className="d-btn d-btn-primary mt-5"
            onClick={() => onConnect(DEFAULT_CLIENT)}
          >
            Connect a client
          </button>
        </div>
        <div className="d-pane border-t border-line md:border-t-0 md:border-l">
          <p className="d-label">Pick your client</p>
          <ul className="mt-3 grid grid-cols-2 gap-2">
            {CLIENT_CARDS.map((agent) => (
              <li key={agent.id}>
                <ClientCard id={agent.id} onClick={() => onConnect(agent.id)} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
