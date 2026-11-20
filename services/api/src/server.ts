import { serve } from '@hono/node-server'
import { createApp } from './app'

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 8800)
const app = createApp({ env: process.env })
serve({ fetch: app.fetch, port, hostname: process.env.API_HOST ?? '127.0.0.1' }, (i) => console.log(`[api] listening on http://${i.address}:${i.port}`))
