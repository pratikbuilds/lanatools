import { type } from 'arktype'

export const HealthResponse = type({ status: "'ok'" })
export type HealthResponse = typeof HealthResponse.infer

export const McpClient = type({
  grantId: 'string',
  clientId: 'string',
  clientName: 'string | null',
  redirectHost: 'string | null',
  scopes: 'string[]',
  connectedAt: 'number',
  lastUsedAt: 'number | null',
})
export type McpClient = typeof McpClient.infer

export const McpClientList = type({ clients: McpClient.array() })
export type McpClientList = typeof McpClientList.infer
