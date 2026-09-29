import { createApp } from './app'
import type { McpDashboardEnv } from './mcp-service'
import { mcpClients } from './routes/mcp-clients'

export { McpAccessService } from './mcp-service'

const app = createApp<McpDashboardEnv>()
app.route('/api/mcp/clients', mcpClients)

export default app
