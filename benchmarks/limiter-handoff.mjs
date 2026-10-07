// Reuse the owned-container, fixed-arrival and audit-reconciliation harness.
import {randomUUID} from 'node:crypto'
process.env.LIMITER_DIAG_STUDY='handoff'
process.env.LIMITER_DIAG_RATE??='4000'
process.env.LIMITER_DIAG_SECONDS??='180'
process.env.LIMITER_DIAG_OUTPUT??='.dev/limiter-handoff-'+randomUUID().slice(0,8)
await import('./limiter-diagnosis.mjs')
