import { AgentPayments } from './agent-payments'
import { AutomaticSOL } from './automatic-sol'
import { PageHead } from './page-head'

export function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" />
      <section className="mt-7" aria-label="Permissions">
        <h2 className="d-h2">Permissions</h2>
        <p className="mt-1 mb-3 text-[13px] text-fg-2">
          What LanaTools may sign with your wallet.
        </p>
        <AgentPayments />
        <AutomaticSOL />
      </section>
    </>
  )
}
