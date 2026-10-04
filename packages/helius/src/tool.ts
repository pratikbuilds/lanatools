import type { z } from 'zod'
import type { HeliusClient } from './client'

export type HeliusTool<TSchema extends z.ZodObject = z.ZodObject> = {
  name: string
  title: string
  description: string
  input: TSchema
  run: (
    ctx: HeliusClient,
    input: z.output<TSchema>,
  ) => Promise<Record<string, unknown>>
}
export function defineTool<TSchema extends z.ZodObject>(
  tool: HeliusTool<TSchema>,
) {
  return tool
}
