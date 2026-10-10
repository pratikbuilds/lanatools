import { transactionLinks } from './routes/transaction-links'
import type { TransactionLinksEnv } from './routes/transaction-links'
import { createApp } from './app'
import type { McpDashboardEnv } from './mcp-service'
import { activity } from './routes/activity'
import { transactions } from './routes/transactions'
import { mcpClients } from './routes/mcp-clients'
import { paymentSignerRoutes } from './routes/payment-signer'
import { walletBalances } from './routes/wallet-balances'
import { walletWithdrawals } from './routes/wallet-withdrawals'
import { earlyAccess } from './routes/early-access'
import type { EarlyAccessEnv } from './routes/early-access'

export { McpAccessService } from './mcp-service'

const app = createApp<McpDashboardEnv & EarlyAccessEnv & TransactionLinksEnv>()
app.route('/api/transaction-links', transactionLinks)
app.route('/api/activity', activity)
app.route('/api/transactions', transactions)
app.route('/api/early-access', earlyAccess)
app.route('/api/mcp/clients', mcpClients)
app.route('/api/payments/signer', paymentSignerRoutes)
app.route('/api/wallet/balances', walletBalances)
app.route('/api/wallet/withdrawals', walletWithdrawals)

export default app
