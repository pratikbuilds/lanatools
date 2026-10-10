import { createFileRoute } from '@tanstack/react-router'
import { PaymentsPage } from '#/components/dashboard/payments-page'

export const Route = createFileRoute('/_account/dashboard/payments')({
  component: PaymentsPage,
})
