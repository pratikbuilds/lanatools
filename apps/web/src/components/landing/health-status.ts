export const healthStatusName = 'API status'

export const healthStatus = {
  paused: 'Waiting for connection',
  checking: 'Checking the API',
  unreachable: 'API unreachable',
  operational: 'API operational',
} as const

type HealthSnapshot = {
  fetchStatus: 'fetching' | 'paused' | 'idle'
  isPending: boolean
  isFetching: boolean
  isError: boolean
}

export function healthStatusText(health: HealthSnapshot): string {
  if (health.fetchStatus === 'paused') return healthStatus.paused
  if (health.isPending || health.isFetching) return healthStatus.checking
  if (health.isError) return healthStatus.unreachable
  return healthStatus.operational
}
