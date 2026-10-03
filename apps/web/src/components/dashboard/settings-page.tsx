import { AgentPayments } from './agent-payments'

export function SettingsPage() {
  return (
    <>
      <h1 className="pt-9 text-[22px] font-bold tracking-[-0.03em]">
        Settings
      </h1>
      <section className="mt-6">
        <h2 className="text-[15px] font-bold">Permissions</h2>
        <p className="mt-1 mb-3.5 text-[12px] text-mute">
          What LanaTools may sign with your wallet.
        </p>
        <AgentPayments />
      </section>
    </>
  )
}
