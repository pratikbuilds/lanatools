import { type } from 'arktype'

const Port = type('string.digits')
  .pipe(Number)
  .pipe(type('number.integer >= 1 & number <= 65535'))

export function readPort(value = '3000') {
  const port = Port(value)
  if (port instanceof type.errors) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  return port
}
