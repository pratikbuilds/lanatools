import { expect, test } from 'bun:test'
import { completeApproval } from './complete-approval'

test('a failed OAuth completion never activates the grant', async () => {
  let activated = false
  await expect(
    completeApproval(
      async () => {
        throw new Error('OAuth storage failed')
      },
      async () => {
        activated = true
      },
    ),
  ).rejects.toThrow('OAuth storage failed')
  expect(activated).toBe(false)
})
