import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_TOOL_SCOPES,
  MCP_SCOPES,
  TOOL_SCOPES,
  grantScopes,
} from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'
import { ToolAccess } from '../consent/permissions'

function access(selected: readonly ToolScope[], payLimit = 'LIMIT FIELD') {
  return renderToStaticMarkup(
    createElement(ToolAccess, { selected, onChange: () => {}, payLimit }),
  )
}

function switchFor(html: string, scope: ToolScope) {
  return new RegExp(
    `role="switch" aria-checked="(true|false)" aria-labelledby="tool-${scope}"`,
  ).exec(html)?.[1]
}

test('Helius and Pay are on by default; Jupiter and Phoenix are off', () => {
  expect(DEFAULT_TOOL_SCOPES).toEqual(['helius:read', 'payments:pay'])
  const html = access(DEFAULT_TOOL_SCOPES)
  expect(switchFor(html, 'helius:read')).toBe('true')
  expect(switchFor(html, 'payments:pay')).toBe('true')
  expect(switchFor(html, 'jupiter:read')).toBe('false')
  expect(switchFor(html, 'phoenix:read')).toBe('false')
  expect(html).toContain('2 of 4 on')
})

test('every tool family has a switch, and the catalog is always included', () => {
  const html = access([])
  for (const scope of TOOL_SCOPES) expect(switchFor(html, scope)).toBe('false')
  expect(html).toContain('Always included')
  expect(html).toContain('pay.sh catalog')
  expect(html).toContain('0 of 4 on')
})

test('the spending limit only shows while Pay is on', () => {
  expect(access(['payments:pay'])).toContain('LIMIT FIELD')
  expect(access(['helius:read'])).not.toContain('LIMIT FIELD')
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
