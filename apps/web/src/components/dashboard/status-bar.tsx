import { MCP_HOST } from '#/components/landing/copy-url'
import { usePaymentsState } from './agent-payments'
import { useMcpClients } from './use-mcp-clients'

export { NetworkStatus } from './network-status'

const LABELS = {
  on: 'Agent payments on',
  off: 'Agent payments not set up',
  removed: 'LanaTools access removed',
  'no-wallet': 'No payment wallet yet',
  loading: 'Agent payments…',
  unknown: 'Payment status unavailable',
}
// A wallet agents cannot pay from is a warning; the rest is neutral.
const STATES = {
  on: 'live',
  off: 'full',
  removed: 'full',
  'no-wallet': 'idle',
  loading: 'idle',
  unknown: 'idle',
}

/** The status bar's opening cells: whether agents can pay, and through what. */
export function PaymentStatus() {
  const payments = usePaymentsState()
  const count = useMcpClients().data?.length
  return (
    <>
      <span className="d-status" data-state={STATES[payments]}>
        <i aria-hidden="true" />
        {LABELS[payments]}
      </span>
      <span className="max-sm:hidden">
        {MCP_HOST}
        {count !== undefined &&
          ` · ${count} ${count === 1 ? 'client' : 'clients'} connected`}
      </span>
    </>
  )
}
