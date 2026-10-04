import { z } from 'zod'

export const Identity = z.object({
  grantId: z.uuid(),
  userId: z.string().min(1),
  clientId: z.string().min(1),
})

export type GrantIdentity = z.infer<typeof Identity>
