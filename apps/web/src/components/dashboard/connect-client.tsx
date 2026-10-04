import { useState } from 'react'
import {
  CLIENTS,
  CLIENT_IDS,
  CopyStatus,
  copyLabel,
  useCopy,
} from '#/components/landing/copy-url'
import type { AgentId } from '#/components/landing/logos'
import { Drawer, DrawerHeader } from './drawer'

/** Opens the setup for a new client in a drawer. */
export function ConnectClientButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="d-btn" onClick={() => setOpen(true)}>
        <span aria-hidden="true">＋</span> Connect a client
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        label="Connect a client"
      >
        <DrawerHeader
          title="Connect a client"
          detail="One URL for every AI client"
          onClose={() => setOpen(false)}
        />
        <ConnectClient />
      </Drawer>
    </>
  )
}

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
      <div role="group" aria-label="Your client" className="d-seg flex-wrap">
        {CLIENT_IDS.map((each) => (
          <button
            key={each}
            type="button"
            aria-pressed={each === id}
            onClick={() => setId(each)}
          >
            {CLIENTS[each].tab}
          </button>
        ))}
      </div>
      <p className="mt-5 text-[12.5px] text-fg-3">
        Add this to {client.tab}, in {client.file}.
      </p>
      <pre className="d-well mt-2 text-[12.5px] leading-5 whitespace-pre-wrap">
        {setup}
      </pre>
      <button
        type="button"
        className="d-btn d-btn-primary mt-3.5"
        onClick={() => void copy()}
      >
        {copyLabel(state, 'Copy')}
      </button>
      <CopyStatus state={state} subject="setup" />
      <p className="mt-5 text-[12.5px] text-fg-3">
        LanaTools then asks you to approve the client and set its spending
        limit. It appears under Connected clients once approved.
      </p>
    </>
  )
}
