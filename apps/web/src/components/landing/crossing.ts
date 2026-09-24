export const PERIOD = 9
export const STAGGER = PERIOD / 4
export const ENTRY = 0.18
export const PHASE = STAGGER / PERIOD / 3
export const EXIT = ENTRY + PHASE * 3

export const CROSSING_MESSAGES: readonly string[] = [
  'checking limit',
  'checking permissions',
  'recording call',
]
