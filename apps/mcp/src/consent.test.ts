import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MCP_SCOPES, isMcpScope } from '@lanatools/contracts'
import type { McpScope } from '@lanatools/contracts'
import { Permissions } from '../consent/permissions'

function permissions(scopes: McpScope[]) {
  return renderToStaticMarkup(createElement(Permissions, { scopes }))
}

test('chain:read is a supported scope independently of identity and payment access', () => {
  expect(MCP_SCOPES).toContain('chain:read')
  expect(isMcpScope('chain:read')).toBe(true)
  expect(isMcpScope('chain:write')).toBe(false)
  const html = permissions(['chain:read'])
  expect(html).toContain('Read Solana data')
  expect(html).toContain('No wallet or payment access')
  expect(html).not.toContain('Read account identity')
  expect(html).not.toContain('Pay for requests')
})

test('consent shows only requested permissions with and without chain:read', () => {
  expect(permissions(['account:read'])).not.toContain('Read Solana data')
  const combined = permissions(['account:read', 'chain:read'])
  expect(combined).toContain('Read Solana data')
  expect(combined).toContain('Read account identity')
  expect(combined).toContain('No wallet or payment access')
  const all = permissions([...MCP_SCOPES])
  expect(all).toContain('Read Solana data')
  expect(all).toContain('Pay for requests from your wallet')
  expect(all).not.toContain('No wallet or payment access')
})

test('Jupiter consent retains the existing access explanation', () => {
  const html = permissions(['jupiter:read'])
  expect(html).toContain('Jupiter access')
  expect(html).toContain('public-wallet portfolios and lending data')
  expect(html).not.toContain('Read Solana data')
  expect(html).toContain('No wallet or payment access')
})
