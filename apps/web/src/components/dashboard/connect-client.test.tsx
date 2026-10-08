import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { MCP_URL, SKILL_URL } from '#/components/landing/copy-url'
import {
  CURSOR_INSTALL_URL,
  DEFAULT_CLIENT,
  ConnectClient,
  ConnectFirstClient,
} from './connect-client'

test('the empty state offers every client, Grok bot first', () => {
  const html = renderToString(<ConnectFirstClient onConnect={() => {}} />)
  expect(html).toContain('Let’s bring in your first agent')
  // The cards come after the intro, which names the clients in prose.
  const cards = html.slice(html.indexOf('Pick your client'))
  const names = ['Grok bot', 'Codex', 'Claude', 'Cursor', 'Other agents']
  const positions = names.map((name) => cards.indexOf(name))
  expect(positions.every((at) => at > 0)).toBe(true)
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
  expect(DEFAULT_CLIENT).toBe('grok')
  expect(html).toContain('spending limit')
})

test('the setup opens on the chosen client with its own snippet', () => {
  const html = renderToString(<ConnectClient initial="codex" />)
  expect(html).toContain('Set up Codex')
  expect(html).toContain('codex mcp add lanatools --url')
  expect(html).not.toContain('$ codex')
  // The config file is still there for those who prefer it.
  expect(html).toContain('[mcp_servers.lanatools]')
  expect(html).toContain(MCP_URL)
  expect(html).not.toContain('claude mcp add')
})

test('the Claude setup is the terminal command, without its prompt', () => {
  const html = renderToString(<ConnectClient initial="claude" />)
  expect(html).toContain('claude mcp add --transport http lanatools')
  expect(html).not.toContain('$ claude')
  // The Claude app connects through its connector settings instead.
  expect(html).toContain('Connectors')
})

test('Cursor gets a one-click install carrying the server URL', () => {
  const html = renderToString(<ConnectClient initial="cursor" />)
  expect(html).toContain('Install in Cursor')
  const config = new URL(CURSOR_INSTALL_URL).searchParams.get('config')
  expect(JSON.parse(atob(config ?? ''))).toEqual({ url: MCP_URL })
})

test('every client can be set up from the skill instead', () => {
  for (const initial of [
    'grok',
    'codex',
    'claude',
    'cursor',
    'others',
  ] as const) {
    const html = renderToString(<ConnectClient initial={initial} />)
    expect(html).toContain(SKILL_URL)
    expect(html).toContain(MCP_URL)
  }
})

test('the skill the dashboard points at names the server and the first tool', async () => {
  const skill = await Bun.file(
    new URL('../../../public/SKILL.md', import.meta.url),
  ).text()
  expect(skill.startsWith('---\nname: lanatools-connect\n')).toBe(true)
  expect(skill).toContain(MCP_URL)
  expect(skill).toContain('`whoami`')
  expect(new URL(SKILL_URL).pathname).toBe('/SKILL.md')
})
