import { type } from 'arktype'

export const HealthResponse = type({ status: "'ok'" })
export type HealthResponse = typeof HealthResponse.infer
