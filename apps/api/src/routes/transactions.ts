import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { TransactionsQuery } from '@lanatools/contracts'
import type {
  TransactionActivityItem,
  TransactionsPage,
} from '@lanatools/contracts'
import type { McpEnv } from '../mcp-service'
import {
  TRANSACTIONS_PAGE_SIZE,
  listTransactions,
  parseTransactionsCursor,
  readTransaction,
} from '../transactions/list'
import type { TransactionExecutionEnv } from '../transactions/requests'
import { privyAuth } from './privy-auth'

/** The dashboard's read of the signed-in user's transactions. */
export const transactions = new Hono<{
  Bindings: McpEnv & TransactionExecutionEnv
  Variables: { userId: string }
}>()
  .use(privyAuth)
  .get('/', async (c) => {
    const query = TransactionsQuery(c.req.query())
    if (query instanceof type.errors) throw new HTTPException(400)
    const before =
      query.before === undefined
        ? undefined
        : parseTransactionsCursor(query.before)
    if (before === null) throw new HTTPException(400)
    const { before: _, ...filter } = query
    const page = await listTransactions(c.env, c.get('userId'), {
      ...filter,
      before,
      limit: TRANSACTIONS_PAGE_SIZE,
    })
    return c.json(page satisfies TransactionsPage)
  })
  .get('/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const item = await readTransaction(
      c.env,
      c.get('userId'),
      c.req.param('id'),
    )
    if (!item) throw new HTTPException(404)
    return c.json(item satisfies TransactionActivityItem)
  })
