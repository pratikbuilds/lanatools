import type { z } from 'zod'
import type { PortfolioInput } from '../inputs'
import type { ReadContext } from '../client'
import { isRecord, unavailable } from '../client'
import type { PortfolioData } from '../types'

export async function getPortfolio(
  context: ReadContext,
  input: z.output<typeof PortfolioInput>,
): Promise<PortfolioData> {
  if (input.view === 'platforms')
    return {
      view: input.view,
      platforms: context.records(await context.get('/portfolio/v1/platforms')),
    }
  const value = await context.get(
    `/portfolio/v1/${input.view === 'positions' ? 'positions' : 'staked-jup'}/${input.wallet}`,
    input.view === 'positions' && input.platforms
      ? { platforms: input.platforms.join(',') }
      : {},
  )
  if (!isRecord(value)) throw unavailable()
  if (input.view === 'staked_jup') {
    if (
      typeof value.stakedAmount !== 'number' ||
      !Number.isFinite(value.stakedAmount) ||
      !Array.isArray(value.unstaking)
    )
      throw unavailable('Jupiter returned unusable staking amounts')
    return {
      view: input.view,
      wallet: input.wallet,
      stakedAmount: value.stakedAmount,
      unstaking: context.records(value.unstaking),
    }
  }
  const reports = value.fetcherReports
  let partial = true
  if (Array.isArray(reports) && reports.length > 0) {
    partial = reports.some(
      (report) =>
        !isRecord(report) ||
        !['succeeded', 'ok'].includes(String(report.status)) ||
        Boolean(report.error),
    )
    if (
      reports.some(
        (report) =>
          !isRecord(report) ||
          !['succeeded', 'ok', 'failed'].includes(String(report.status)),
      )
    )
      context.warnings.push(
        'Unknown portfolio fetcher status; completeness cannot be confirmed.',
      )
  } else
    context.warnings.push(
      'Portfolio fetcher reports are unavailable; completeness cannot be confirmed.',
    )
  if (partial)
    context.warnings.push(
      'Portfolio data may be incomplete; do not treat it as a complete account valuation.',
    )
  return { view: input.view, wallet: input.wallet, portfolio: value, partial }
}
