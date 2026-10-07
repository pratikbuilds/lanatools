import { createApp } from './app'
import type { McpDashboardEnv } from './mcp-service'
import { activity } from './routes/activity'
import { mcpClients } from './routes/mcp-clients'
import { paymentSignerRoutes } from './routes/payment-signer'
import { walletBalances } from './routes/wallet-balances'
import { walletWithdrawals } from './routes/wallet-withdrawals'
import { earlyAccess } from './routes/early-access'
import type { EarlyAccessEnv } from './routes/early-access'
import { transactionSignerRoutes } from './routes/transaction-signer'
import { transactionLinkRoutes } from './routes/transaction-link'

export { McpAccessService } from './mcp-service'

const app = createApp<McpDashboardEnv & EarlyAccessEnv>()
app.route('/api/activity', activity)
app.route('/api/early-access', earlyAccess)
app.route('/api/mcp/clients', mcpClients)
app.route('/api/payments/signer', paymentSignerRoutes)
app.route('/api/wallet/balances', walletBalances)
app.route('/api/transactions/link', transactionLinkRoutes)
app.route('/api/wallet/withdrawals', walletWithdrawals)
app.route('/api/transactions/signer', transactionSignerRoutes)

export default app
