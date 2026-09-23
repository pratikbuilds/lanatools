import type { AgentId } from './logos'

export type Permission = 'read' | 'pay' | 'prepare'

export type Client = {
  id: AgentId
  name: string
  kind: string
  cap: number
  spent: number
  can: Array<Permission>
}

// Illustrative figures. Nothing here is live data.
export const CLIENTS: Array<Client> = [
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'desktop',
    cap: 25,
    spent: 6.63,
    can: ['read', 'pay', 'prepare'],
  },
  {
    id: 'claude',
    name: 'Claude',
    kind: 'desktop',
    cap: 10,
    spent: 1.2,
    can: ['read', 'prepare'],
  },
  {
    id: 'codex',
    name: 'Codex',
    kind: 'desktop · cloud',
    cap: 15,
    spent: 4.5,
    can: ['read', 'pay'],
  },
  {
    id: 'grok',
    name: 'Grok',
    kind: 'cloud',
    cap: 8,
    spent: 0.4,
    can: ['read'],
  },
  {
    id: 'cloud',
    name: 'Cloud agent',
    kind: 'server',
    cap: 5,
    spent: 5,
    can: ['read', 'pay'],
  },
]

export const PROVIDERS = ['pay.sh', 'Helius', 'Jupiter', 'Dune']

export const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

export const whole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
