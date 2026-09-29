import { createApp } from './app'
import type { McpDashboardEnv } from './mcp-service'
import { mcpClients } from './routes/mcp-clients'
import { paymentSignerRoutes } from './routes/payment-signer'

export { McpAccessService } from './mcp-service'

const app = createApp<McpDashboardEnv>()
app.route('/api/mcp/clients', mcpClients)
app.route('/api/payments/signer', paymentSignerRoutes)

export default app
