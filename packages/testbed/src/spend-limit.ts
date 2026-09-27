/** Local proof ledger. Production needs a durable atomic reservation store. */
export class SpendLimit {
  private spent = 0n
  private readonly held = new Map<string, bigint>()

  constructor(readonly cap: bigint) {}

  get remaining() {
    return (
      this.cap -
      this.spent -
      [...this.held.values()].reduce((a, b) => a + b, 0n)
    )
  }

  reserve(maximum: bigint) {
    if (maximum <= 0n || maximum > this.remaining)
      throw new Error('Wallet spending limit exceeded')
    const id = crypto.randomUUID()
    this.held.set(id, maximum)
    return id
  }

  settle(id: string, actual: bigint) {
    const maximum = this.held.get(id)
    if (maximum === undefined || actual < 0n || actual > maximum)
      throw new Error('Invalid payment settlement')
    this.held.delete(id)
    this.spent += actual
  }

  releaseUnsigned(id: string) {
    if (!this.held.delete(id)) throw new Error('Unknown payment reservation')
  }

  /** Keep uncertain payments held until their outcome is reconciled. */
  get pending() {
    return this.held.size
  }
}
