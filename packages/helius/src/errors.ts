export type HeliusErrorCode =
  | 'invalid_input'
  | 'rate_limited'
  | 'timeout'
  | 'plan_required'
  | 'upstream_error'
const messages: Record<HeliusErrorCode, string> = {
  invalid_input: 'Check the tool name and input values.',
  rate_limited: 'The data provider is rate limited. Try again shortly.',
  timeout: 'The data provider did not respond in time.',
  plan_required: 'This request requires a supported Helius plan.',
  upstream_error:
    'The data provider is unavailable or returned an invalid response.',
}
/** Never forward upstream messages, URLs, response bodies, or causes. */
export class HeliusError extends Error {
  constructor(public readonly code: HeliusErrorCode) {
    super(messages[code])
  }
}
export function safeError(error: unknown) {
  const code = error instanceof HeliusError ? error.code : 'upstream_error'
  return { code, message: messages[code] }
}
