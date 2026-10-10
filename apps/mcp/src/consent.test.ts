import { expect, test } from 'bun:test'
import { createElement } from 'react'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_TOOL_SCOPES,
  MAX_CLIENT_LIMIT_MICRO_USD,
  MCP_SCOPES,
  TOOL_SCOPES,
  formatUsd,
  grantScopes,
} from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'
import { ConsentCard } from '../consent/consent-card'
import { ToolAccess } from '../consent/permissions'

function access(selected: readonly ToolScope[], payLimit = 'LIMIT FIELD') {
  return renderToStaticMarkup(
    createElement(ToolAccess, { selected, onChange: () => {}, payLimit }),
  )
}

/** Whether a tool family's checkbox is ticked, or undefined if it has none. */
function ticked(html: string, scope: ToolScope) {
  return new RegExp(`<input type="checkbox"[^>]* name="${scope}"[^>]*>`)
    .exec(html)?.[0]
    .includes('checked=""')
}

function card(props: Partial<ComponentProps<typeof ConsentCard>> = {}) {
  return renderToStaticMarkup(
    createElement(ConsentCard, {
      clientName: 'Test Client',
      hasHandle: true,
      ready: true,
      signedIn: true,
      account: {
        label: 'User',
        detail: 'user@example.com',
        wallet: false,
      },
      scopes: DEFAULT_TOOL_SCOPES,
      limitUsd: '1.00',
      busy: undefined,
      message: '',
      onScopes: () => {},
      onLimitUsd: () => {},
      onSignIn: () => {},
      onSwitchAccount: () => {},
      onDecide: () => {},
      ...props,
    }),
  )
}

test('Helius and Pay are ticked by default; Jupiter and Phoenix are not', () => {
  expect(DEFAULT_TOOL_SCOPES).toEqual(['helius:read', 'payments:pay'])
  const html = access(DEFAULT_TOOL_SCOPES)
  expect(ticked(html, 'helius:read')).toBe(true)
  expect(ticked(html, 'payments:pay')).toBe(true)
  expect(ticked(html, 'jupiter:read')).toBe(false)
  expect(ticked(html, 'phoenix:read')).toBe(false)
})

test('every tool family has a checkbox, and the catalog is always included', () => {
  const html = access([])
  for (const scope of TOOL_SCOPES) expect(ticked(html, scope)).toBe(false)
  expect(html).toContain('Always included')
  expect(html).toContain('pay.sh catalog')
})

test('transaction permissions disclose execution without approval or amount limits', () => {
  const html = access(['jupiter:read', 'solana:transfer'])
  expect(html).toContain(
    'Swap tokens from your LanaTools wallet without further approval or an amount limit.',
  )
  expect(html).toContain(
    'Send SOL and tokens from your LanaTools wallet without further approval or an amount limit.',
  )
})

test('the spending limit only shows while Pay is ticked', () => {
  expect(access(['payments:pay'])).toContain('LIMIT FIELD')
  expect(access(['helius:read'])).not.toContain('LIMIT FIELD')
})

test('Pay is the last row, with its limit under it', () => {
  const html = access([...TOOL_SCOPES])
  const at = (scope: ToolScope) => html.indexOf(` name="${scope}"`)
  for (const scope of TOOL_SCOPES)
    if (scope !== 'payments:pay')
      expect(at(scope)).toBeLessThan(at('payments:pay'))
  expect(html.indexOf('LIMIT FIELD')).toBeGreaterThan(at('payments:pay'))
})

test('every checkbox is named and described by its own row', () => {
  const html = access([])
  for (const scope of TOOL_SCOPES) {
    expect(html).toContain(`aria-labelledby="tool-${scope}"`)
    expect(html).toContain(` id="tool-${scope}"`)
    expect(html).toContain(`aria-describedby="tool-${scope}-detail"`)
    expect(html).toContain(` id="tool-${scope}-detail"`)
  }
})

test('the card names the client and the account it connects to', () => {
  const html = card()
  expect(html).toContain('Connect Test Client?')
  expect(html).toContain('user@example.com')
  expect(html).toContain('>Connect</button>')
  expect(html).toContain('>Deny</button>')
})

test('a wallet account shows its address with both ends readable', () => {
  const address = 'huYN3HrKQvoMS2EnNas5ZTUSQPU4x7MNsxyiSJHiiY4'
  const html = card({
    account: { label: 'huYN…iiY4', detail: address, wallet: true },
  })
  expect(html).toContain('Signed in as')
  expect(html).toContain(`title="${address}"`)
  expect(html).toContain('>huYN</strong>')
  expect(html).toContain('>iiY4</strong>')
  expect(html).toContain('Use another account')
})

test('a signed-out user is asked to sign in before connecting', () => {
  const html = card({ signedIn: false, account: undefined })
  expect(html).toContain('>Sign in to connect</button>')
  expect(html).not.toContain('>Connect</button>')
})

test('nothing can be answered until the sign-in state is known', () => {
  const html = card({ ready: false, signedIn: false, account: undefined })
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/)
  expect(html).not.toContain('Sign in')
})

test('only the answer being sent changes its button, and all are held', () => {
  const approving = card({ busy: 'approve' })
  expect(approving).toMatch(/<button[^>]*disabled=""[^>]*>Connecting…</)
  expect(approving).toMatch(/<button[^>]*disabled=""[^>]*>Deny</)
  const denying = card({ busy: 'deny' })
  expect(denying).toMatch(/<button[^>]*disabled=""[^>]*>Connect</)
  expect(denying).toMatch(/<button[^>]*disabled=""[^>]*>Denying…</)
  expect(denying).not.toMatch(/<input(?![^>]*disabled="")[^>]*>/)
})

test('an answer that fails is explained beside the buttons', () => {
  const html = card({ message: 'Connection failed. Please try again.' })
  expect(html).toContain('role="alert"')
  expect(html).toContain('Connection failed. Please try again.')
  expect(html).toContain('>Connect</button>')
})

test('a limit that cannot be used holds Connect back and says why', () => {
  const html = card({ limitUsd: 'abc' })
  expect(html).toContain(
    `Enter an amount up to ${formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}`,
  )
  expect(html).toContain('aria-describedby="limit-hint"')
  expect(html).toContain('id="limit-hint"')
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/)
  // Without Pay there is no limit to get wrong.
  const reads = card({ limitUsd: 'abc', scopes: ['helius:read'] })
  expect(reads).not.toContain('Enter an amount')
  expect(reads).not.toMatch(/<button[^>]*disabled=""[^>]*>Connect<\/button>/)
})

test('without a request the card only says what went wrong', () => {
  const expired = card({
    clientName: undefined,
    message: 'This connection request has expired.',
  })
  expect(expired).toContain('This connection request has expired.')
  expect(expired).not.toContain('type="checkbox"')
  expect(card({ clientName: undefined, hasHandle: false })).toContain(
    'Open this page from your MCP client to connect.',
  )
})

test('grant scopes add account:read and keep a fixed order', () => {
  expect(grantScopes([])).toEqual(['account:read'])
  expect(grantScopes(['phoenix:read', 'helius:read'])).toEqual([
    'account:read',
    'helius:read',
    'phoenix:read',
  ])
  expect(grantScopes([...TOOL_SCOPES])).toEqual([...MCP_SCOPES])
  expect(grantScopes(['account:read'])).toBeNull()
  expect(grantScopes(['chain:read'])).toBeNull()
  expect(grantScopes(['helius:read', 'helius:read'])).toBeNull()
})
