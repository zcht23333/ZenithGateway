import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const dir = fileURLToPath(new URL('../.dev/observability/secrets/', import.meta.url))
await mkdir(dir, { recursive: true, mode: 0o700 })
await chmod(dir, 0o700)
for (const name of ['admin-token', 'metrics-token', 'grafana-password']) {
  const file = join(dir, name)
  try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o644 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  // The private directory protects host access; individual read-only mounts serve non-root containers.
  const value = (await readFile(file, 'utf8')).trim()
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Unexpected secret format in ' + file)
}
console.log('Local credentials are ready in .dev/observability/secrets (values are not logged).')
