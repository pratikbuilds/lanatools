import { createApp } from './app'
import { readPort } from './config'

const app = createApp()

export default {
  port: readPort(process.env.PORT),
  fetch: app.fetch,
}
