import { isAddress, isSignature } from '@solana/kit'
import { z } from 'zod'

export const addressInput = z
  .string()
  .refine(isAddress, 'A valid base58 Solana address is required')
export const signatureInput = z
  .string()
  .refine(isSignature, 'A valid base58 Solana signature is required')
