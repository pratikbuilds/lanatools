import type { JupiterClientOptions } from './client'
import type { BuildSwapInput, JupiterRequest } from './inputs'
import { readJupiter } from './read'
import type { BuildSwapData, ExecuteSwapData, JupiterOutcome } from './types'
import type { z } from 'zod'
import { executeSwap, prepareSwap } from './swap-execution'
import type { ExecuteSwapInput } from './swap-execution'

export class JupiterClient {
  constructor(private readonly options: JupiterClientOptions) {}

  read(request: JupiterRequest): Promise<JupiterOutcome> {
    return readJupiter(this.options, request)
  }

  prepareSwap(
    input: z.input<typeof BuildSwapInput>,
  ): Promise<JupiterOutcome<BuildSwapData>> {
    return prepareSwap(this.options, input)
  }

  executeSwap(
    input: ExecuteSwapInput,
  ): Promise<JupiterOutcome<ExecuteSwapData>> {
    return executeSwap(this.options, input)
  }
}
