import { AgentPayments } from './agent-payments'

export function SettingsPage() {
  return (
    <>
      <h1 className="pt-9 text-[22px] font-bold tracking-[-0.03em]">
        Settings
      </h1>
      <section className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-[1.5px] border-ink pb-3">
          <h2 className="text-[15px] font-bold">Permissions</h2>
          <p className="text-[12px] text-mute">
            What LanaTools may sign with your wallet.
          </p>
        </div>
        <AgentPayments />
      </section>
    </>
  )
}
