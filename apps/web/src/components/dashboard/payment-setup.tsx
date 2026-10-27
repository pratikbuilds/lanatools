import { useAttachPaymentSigner } from './agent-payments'

/** Runs the one-time payment setup for whichever dashboard page is open. */
export function PaymentSetup() {
  useAttachPaymentSigner()
  return null
}
