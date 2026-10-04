import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { heliusTools } from '@lanatools/helius'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const record = z.record(z.string(), z.unknown())
const nullableString = z.string().nullable()
const transaction = z.object({
  signature: z.string(),
  found: z.boolean(),
  status: z.enum(['succeeded', 'failed']).optional(),
  fee_sol: nullableString.optional(),
  transfers: z.array(record).optional(),
  programs: z.array(z.string()).optional(),
})

export type ChainFixture = { input: Record<string, unknown>; output: z.ZodType }

/** Fail closed when an exported tool has not yet received a smoke fixture. */
export function chainFixtures(
  env: Record<string, string | undefined>,
): Map<string, ChainFixture> {
  const address =
    env.LANATOOLS_DEVNET_ADDRESS ?? '11111111111111111111111111111111'
  const signature = env.LANATOOLS_DEVNET_SIGNATURE
  assert.ok(
    signature,
    'Set LANATOOLS_DEVNET_SIGNATURE to an existing devnet transaction signature',
  )
  const mint =
    env.LANATOOLS_DEVNET_MINT ?? 'So11111111111111111111111111111111111111112'
  const fixtures: Record<string, ChainFixture> = {
    get_accounts: {
      input: { addresses: [address] },
      output: z.object({
        accounts: z
          .array(
            z.object({
              address: z.string(),
              exists: z.boolean(),
              kind: nullableString,
              summary: z.string(),
            }),
          )
          .length(1),
      }),
    },
    get_transactions: {
      input: { signatures: [signature] },
      output: z.object({
        transactions: z
          .array(
            transaction.extend({
              found: z.literal(true),
              status: z.enum(['succeeded', 'failed']),
              fee_sol: z.string(),
              transfers: z.array(record),
              programs: z.array(z.string()),
            }),
          )
          .length(1),
      }),
    },
    get_wallet_holdings: {
      input: { owner: address },
      output: z.object({
        sol: z.object({
          amount: nullableString,
          raw_amount: nullableString,
          usd_price: z.number().nullable(),
          usd_value: z.number().nullable(),
        }),
        tokens: z.array(
          z.object({
            mint: z.string(),
            amount: nullableString,
            raw_amount: nullableString,
          }),
        ),
        nfts: z.array(z.object({ id: z.string(), kind: z.literal('nft') })),
        nft_count: z.number().nonnegative(),
        total_usd_value: z.number().nullable(),
        next_cursor: nullableString,
      }),
    },
    get_token_info: {
      input: { ids: [mint] },
      output: z.object({
        assets: z.array(
          z.object({
            id: z.string(),
            kind: z.enum(['token', 'nft', 'unknown']),
            name: nullableString,
            symbol: nullableString,
            supply: nullableString,
          }),
        ),
        not_found: z.array(z.string()),
      }),
    },
    get_transaction_history: {
      input: { address, limit: 1 },
      output: z.object({
        transactions: z.array(record),
        next_cursor: nullableString,
      }),
    },
  }
  return new Map(
    heliusTools.map((tool) => {
      const fixture = fixtures[tool.name]
      assert.ok(
        fixture,
        `Add a devnet fixture and output validator for exported tool ${tool.name}`,
      )
      assert.ok(
        !('network' in fixture.input),
        'The caller must not select a network',
      )
      const parsed = tool.input.safeParse(fixture.input)
      assert.ok(parsed.success, `Update the input fixture for ${tool.name}`)
      return [tool.name, fixture] as const
    }),
  )
}

/** Assertions never include the response or secret in their error messages. */
export function assertNoSecrets(value: unknown, secrets: readonly string[]) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  assert.ok(
    !/[?&]api-key=[^\s&"<>]+/i.test(text),
    'Provider credential URL found in captured output',
  )
  for (const secret of secrets.filter(Boolean)) {
    assert.ok(
      !text.includes(secret) && !text.includes(encodeURIComponent(secret)),
      'Secret found in captured output',
    )
  }
}

const LedgerRow = z.object({
  tool: z.string(),
  network: z.literal('devnet'),
  status: z.literal('ok'),
  credits: z.number().int().nonnegative(),
  error_code: z.null(),
})

export function assertToolLedger(value: unknown, names: readonly string[]) {
  const rows = z.array(LedgerRow).safeParse(value)
  assert.ok(
    rows.success,
    'Tool ledger must contain successful devnet rows with nonnegative credits and no errors',
  )
  assert.equal(
    rows.data.length,
    names.length,
    'Expected exactly one tool_activity row per tool call',
  )
  for (const name of names) {
    const matches: z.infer<typeof LedgerRow>[] = rows.data.filter(
      (row) => row.tool === name,
    )
    assert.equal(matches.length, 1, `Expected one ledger row for ${name}`)
    if (
      ['get_accounts', 'get_transactions', 'get_transaction_history'].includes(
        name,
      )
    )
      assert.ok(
        matches[0]!.credits > 0,
        `Expected provider credits for ${name}`,
      )
    // A documented DAS no-assets/not-found response can legitimately use zero credits.
  }
}

export async function verifyLocalLedger(
  clientId: string,
  started: number,
  ended: number,
  names: string[],
) {
  const id = clientId.replaceAll("'", "''")
  const query = `SELECT tool, network, status, credits, error_code FROM tool_activity WHERE client_id = '${id}' AND created_at >= ${started} AND created_at <= ${ended} ORDER BY created_at, id`
  const { stdout } = await execute(
    'wrangler',
    [
      'd1',
      'execute',
      'lanatools-local',
      '--local',
      '--json',
      '-c',
      'apps/api/wrangler.local.jsonc',
      '--persist-to',
      'apps/api/.wrangler/state',
      '--command',
      query,
    ],
    { cwd: repository, maxBuffer: 1024 * 1024 },
  )
  const batches = z
    .array(z.object({ results: z.array(z.unknown()) }))
    .parse(JSON.parse(stdout))
  assertToolLedger(
    batches.flatMap((batch) => batch.results),
    names,
  )
}

export async function verifyWorkerLog(
  path: string,
  secrets: readonly string[],
) {
  assertNoSecrets(await readFile(path, 'utf8'), secrets)
}
