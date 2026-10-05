import { expect, test } from 'bun:test'
import { z } from 'zod'
import { lookupTool } from './index'
import { toCallToolResult } from './mcp'

const tool = (name: string) => ({
  name,
  title: name,
  description: name,
  input: z.object({}),
})

test('lookupTool finds the provider that owns a tool name', () => {
  const providers = [
    { name: 'a', tools: [tool('a_one')] },
    { name: 'b', tools: [tool('b_one'), tool('b_two')] },
  ]
  expect(lookupTool(providers, 'b_two')?.provider.name).toBe('b')
  expect(lookupTool(providers, 'missing')).toBeNull()
})

test('results put the summary before the JSON and keep only objects structured', () => {
  expect(
    toCallToolResult({ ok: true, result: { n: 1 }, summary: 'One.' }),
  ).toEqual({
    content: [
      { type: 'text', text: 'One.' },
      { type: 'text', text: '{"n":1}' },
    ],
    structuredContent: { n: 1 },
  })
  expect(toCallToolResult({ ok: true, result: [1, 2] })).toEqual({
    content: [{ type: 'text', text: '[1,2]' }],
  })
})

test('errors share one structured shape', () => {
  const error = { code: 'rate_limited', message: 'Later.', retryable: true }
  expect(toCallToolResult({ ok: false, error })).toEqual({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
  })
})
