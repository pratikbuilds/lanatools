import { createFileRoute } from '@tanstack/react-router'
import { WalletPage } from '#/components/dashboard/wallet-page'

export const Route = createFileRoute('/dashboard/')({ component: WalletPage })
