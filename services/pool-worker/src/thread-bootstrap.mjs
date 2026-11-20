// Worker-thread bootstrap: register tsx in this thread (the entry and the workspace packages are TypeScript source), then load the entry.
// Plain .mjs so Node can start it without any loader flag; the parent keeps only its -r/--require preloads.
import { register } from 'tsx/esm/api'

register()
await import('./thread-entry.ts')
