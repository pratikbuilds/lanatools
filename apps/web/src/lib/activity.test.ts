import { expect, test } from 'bun:test'
import {
  callHost,
  dayLabel,
  explorerURL,
  formatTime,
  formatCredits,
} from './activity'

// Local times, because the dashboard shows the viewer's own clock.
const at = (day: number, hour: number, minute = 0, year = 2026) =>
  new Date(year, 9, day, hour, minute).getTime()

test('times are on a 12-hour clock with AM or PM', () => {
  expect(formatTime(at(2, 14, 31))).toBe('2:31 PM')
  expect(formatTime(at(2, 9, 5))).toBe('9:05 AM')
  expect(formatTime(at(2, 0))).toBe('12:00 AM')
  expect(formatTime(at(2, 12))).toBe('12:00 PM')
})

test('a day is named relative to today, then by date', () => {
  const now = at(2, 14)
  expect(dayLabel(at(2, 0, 1), now)).toBe('Today')
  expect(dayLabel(at(1, 23, 59), now)).toBe('Yesterday')
  expect(dayLabel(at(1, 0), now)).toBe('Yesterday')
  // Nine minutes before midnight is still the day it happened on.
  expect(dayLabel(at(1, 23, 51), at(2, 0, 5))).toBe('Yesterday')
  expect(dayLabel(new Date(2026, 8, 30, 12).getTime(), now)).toBe('Sep 30')
  expect(dayLabel(at(2, 12, 0, 2025), now)).toBe('Oct 2, 2025')
})

test('a transaction links to the explorer only on a network it serves', () => {
  expect(explorerURL('devnet', 'sig')).toBe(
    'https://explorer.solana.com/tx/sig?cluster=devnet',
  )
  expect(explorerURL('mainnet', 'sig')).toBe(
    'https://explorer.solana.com/tx/sig',
  )
  expect(explorerURL('sandbox', 'sig')).toBeNull()
  expect(explorerURL(null, 'sig')).toBeNull()
})

test('a call is named by its host, without the scheme', () => {
  expect(callHost({ origin: 'https://weather.example' })).toBe(
    'weather.example',
  )
})

test('credit labels always identify estimates and handle zero and singular', () => {
  expect(formatCredits(0)).toBe('0 estimated credits')
  expect(formatCredits(1)).toBe('1 estimated credit')
  expect(formatCredits(12_345)).toBe('12,345 estimated credits')
})
