// Writes zecca/.env.example from scripts/lib/env-vars.ts (placeholders and documented defaults only, no secret values).
// Run from zecca/: node node_modules/tsx/dist/cli.mjs scripts/gen-env-example.ts
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV_VARS, renderEnvExample } from './lib/env-vars'

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.example')
writeFileSync(target, renderEnvExample())
console.log(`wrote .env.example (${ENV_VARS.length} variables)`)
