import { z } from 'zod'
import type { Fetch } from './source'

/**
 * A minimal client for TypeSafe's System One API (docs.typesafe.ai/api).
 * One request evaluates a `state` against named Choice and Noul questions
 * and answers them all in parallel.
 */
export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'

// Pinned rather than `jev-latest`: ranking thresholds are tuned against one
// version, and the alias moves to new releases without notice.
export const JEV_MODEL = 'jev-1.13.0'

// The API accepts at most this many options in one Choice question.
export const MAX_CHOICE_OPTIONS = 255

export class TypeSafeError extends Error {}

type Text = string | Record<string, unknown> | unknown[]

export type Question =
  | {
      type: 'choice'
      instructions: Text
      criteria: Record<string, Text | null>
    }
  | {
      type: 'noul'
      instructions: Text
      criteria?: { true: Text; false: Text }
    }

export const choice = (
  instructions: Text,
  criteria: Record<string, Text | null>,
): Question => ({ type: 'choice', instructions, criteria })

export const noul = (
  instructions: Text,
  criteria: { true: Text; false: Text },
): Question => ({ type: 'noul', instructions, criteria })

const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
})
const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number() })
const SystemOneResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
})

export type JevOpts = {
  apiKey: string
  timeoutMs: number
  fetch?: Fetch | undefined
}

/**
 * Asks Jev every question about one state. Any failure, including a
 * missing or malformed answer, throws a TypeSafeError so callers can fall
 * back instead of acting on a partial result.
 */
export async function askJev(
  opts: JevOpts,
  state: unknown,
  questions: Record<string, Question>,
) {
  const fetcher = opts.fetch ?? fetch
  const started = performance.now()
  // Reading the body is inside the boundary too: the timeout can fire while
  // it streams, and a malformed body throws while parsing.
  let body: unknown
  try {
    const response = await fetcher(SYSTEM_ONE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    if (!response.ok)
      throw new TypeSafeError(
        `TypeSafe returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
      )
    body = await response.json()
  } catch (cause) {
    if (cause instanceof TypeSafeError) throw cause
    throw new TypeSafeError('TypeSafe request failed', { cause })
  }
  const parsed = SystemOneResponse.safeParse(body)
  if (!parsed.success)
    throw new TypeSafeError('TypeSafe returned an unexpected response')
  const { model, answers, usage } = parsed.data

  const answer = <T>(schema: z.ZodType<T>, key: string) => {
    const result = schema.safeParse(answers[key])
    if (!result.success)
      throw new TypeSafeError(`TypeSafe did not answer ${key}`)
    return result.data
  }
  return {
    model,
    usage,
    ms: Math.round(performance.now() - started),
    /** Every option of a Choice question mapped to its probability. */
    probabilities: (key: string) => answer(ChoiceAnswer, key).probabilities,
    /** The probability that a Noul question's answer is yes. */
    noul: (key: string) => answer(NoulAnswer, key).noul,
  }
}
