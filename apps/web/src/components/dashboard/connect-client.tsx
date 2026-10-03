import { useState } from 'react'
import {
  CLIENTS,
  CLIENT_IDS,
  CopyStatus,
  copyLabel,
  useCopy,
} from '#/components/landing/copy-url'
import type { AgentId } from '#/components/landing/logos'

/**
 * How to add LanaTools to an AI client: pick the client, then copy the one
 * thing it needs. The per-client setup is the landing page's.
 */
export function ConnectClient() {
  const [id, setId] = useState<AgentId>('claude')
  const client = CLIENTS[id]
  const setup = client.lines.join('\n')
  // A terminal line is shown with its prompt and copied without it.
  const { state, copy } = useCopy(setup.replace(/^\$ /, ''))

  return (
    <>
      <div
        role="group"
        aria-label="Your client"
        className="flex flex-wrap gap-1.5"
      >
        {CLIENT_IDS.map((each) => (
          <button
            key={each}
            type="button"
            aria-pressed={each === id}
            onClick={() => setId(each)}
            className="h-[30px] rounded-full border-[1.5px] border-rule px-3 text-[12.5px] aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:font-bold aria-pressed:text-card"
          >
            {CLIENTS[each].tab}
          </button>
        ))}
      </div>
      <p className="mt-5 text-[12px] text-mute">
        Add this to {client.tab}, in {client.file}.
      </p>
      <pre className="mt-2 rounded-[8px] border-[1.5px] border-ink bg-paper px-3.5 py-3 text-[12.5px] leading-5 font-semibold break-all whitespace-pre-wrap">
        {setup}
      </pre>
      <button
        type="button"
        className="btn btn-flat btn-primary mt-3.5"
        onClick={() => void copy()}
      >
        {copyLabel(state, 'Copy')}
      </button>
      <CopyStatus state={state} subject="setup" />
      <p className="mt-5 text-[12px] text-mute">
        LanaTools then asks you to approve the client and set its spending
        limit. It appears under Connected clients once approved.
      </p>
    </>
  )
}
