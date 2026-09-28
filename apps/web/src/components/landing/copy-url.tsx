import { useEffect, useState } from 'react'
import { Logo } from './logo'
import type { AgentId } from './logos'

export const MCP_URL = 'https://mcp.lanatools.sh'
export const MCP_HOST = new URL(MCP_URL).host

type ClientConfig = { tab: string; file: string; lines: Array<string> }

const CLIENT_IDS: Array<AgentId> = [
  'cursor',
  'claude',
  'codex',
  'grok',
  'cloud',
]

const CLIENTS: Record<AgentId, ClientConfig> = {
  cursor: {
    tab: 'Cursor',
    file: '~/.cursor/mcp.json',
    lines: [
      '{',
      '  "mcpServers": {',
      '    "lanatools": {',
      `      "url": "${MCP_URL}"`,
      '    }',
      '  }',
      '}',
    ],
  },
  claude: {
    tab: 'Claude',
    file: 'terminal',
    lines: [`$ claude mcp add --transport http lanatools ${MCP_URL}`],
  },
  codex: {
    tab: 'Codex',
    file: '~/.codex/config.toml',
    lines: ['[mcp_servers.lanatools]', `url = "${MCP_URL}"`],
  },
  grok: {
    tab: 'Grok',
    file: 'MCP settings',
    lines: [MCP_URL],
  },
  cloud: {
    tab: 'Cloud agent',
    file: 'MCP server URL',
    lines: [MCP_URL],
  },
}

type CopyState = 'idle' | 'copied' | 'failed'

export function useCopy(text: string) {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return { state, copy }
}

// Visible label for a copy button in each state.
export function copyLabel(state: CopyState, idle = 'copy') {
  return state === 'copied'
    ? 'copied'
    : state === 'failed'
      ? 'copy failed'
      : idle
}

// Announces the result of a copy to screen readers. Keep it mounted so the
// live region exists before its text changes.
export function CopyStatus({
  state,
  subject = 'URL',
}: {
  state: CopyState
  subject?: string
}) {
  return (
    <span role="status" className="sr-only">
      {state === 'copied'
        ? 'Copied to clipboard'
        : state === 'failed'
          ? `Copy failed. Select the ${subject} and copy it manually.`
          : ''}
    </span>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopy(text)
  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        className="btn btn-sm"
        aria-label={label}
      >
        {copyLabel(state)}
      </button>
      <CopyStatus state={state} />
    </>
  )
}

export function Install() {
  const [client, setClient] = useState<AgentId>('cursor')
  const active = CLIENTS[client]

  return (
    <div className="box box-lg overflow-hidden">
      <div
        role="tablist"
        aria-label="Client"
        className="flex flex-wrap border-b-[1.5px] border-ink"
      >
        {CLIENT_IDS.map((id) => {
          const c = CLIENTS[id]
          const on = id === client
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setClient(id)}
              className={`flex h-10 items-center gap-2 border-r-[1.5px] border-ink px-3.5 text-[12px] font-semibold tracking-wide uppercase ${
                on ? 'bg-card text-ink' : 'bg-paper text-mute hover:text-ink'
              }`}
            >
              <Logo id={id} size={14} />
              {c.tab}
            </button>
          )
        })}
        <span className="ml-auto hidden items-center px-4 text-[12px] text-mute sm:flex">
          {active.file}
        </span>
      </div>
      <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
        <pre className="min-w-0 flex-1 overflow-x-auto text-[14px] leading-6 text-ink sm:text-[15px]">
          {active.lines.map((line, i) => (
            <div
              key={i}
              className="break-all whitespace-pre-wrap sm:break-normal sm:whitespace-pre"
            >
              {line.includes(MCP_URL) ? (
                <>
                  {line.slice(0, line.indexOf(MCP_URL))}
                  <span className="hl">{MCP_URL}</span>
                  {line.slice(line.indexOf(MCP_URL) + MCP_URL.length)}
                </>
              ) : (
                line
              )}
            </div>
          ))}
        </pre>
        <CopyButton
          text={active.lines.join('\n')}
          label={`Copy the ${active.tab} config`}
        />
      </div>
    </div>
  )
}

export function UrlBox() {
  return (
    <div className="box box-lg flex flex-wrap items-center gap-4 px-4 py-4 sm:px-5">
      <code className="min-w-0 flex-1 text-[15px] break-all text-ink sm:text-[17px]">
        <span className="text-mute">$ </span>
        {MCP_URL}
      </code>
      <CopyButton text={MCP_URL} label="Copy the MCP URL" />
    </div>
  )
}
