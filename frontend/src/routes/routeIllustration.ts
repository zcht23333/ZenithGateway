import type { RouteRule } from '../stores/traffic'

export type StationKind = 'entry' | 'limit' | 'rewrite' | 'breaker' | 'target'
export function middleLabel(value: string, limit = 42): string {
  if (value.length <= limit) return value
  const tail = Math.floor(limit * .42)
  return value.slice(0, limit - tail - 1) + '…' + value.slice(-tail)
}
export function uniqueRouteLabels(rows: Pick<RouteRule, 'id'>[]): Map<string, string> {
  const candidates = rows.map(row => middleLabel(row.id))
  const counts = new Map<string, number>()
  candidates.forEach(value => counts.set(value, (counts.get(value) || 0) + 1))
  return new Map(rows.map((row, index) => [row.id, counts.get(candidates[index]) === 1 ? candidates[index] : row.id]))
}
export function targetHost(uri: string): string {
  try { return new URL(uri).host } catch { return uri }
}
export function matchingExample(route: RouteRule): string | null {
  if (!route.path.endsWith('/**')) return null
  const prefix = route.path.slice(0, -3)
  // Only a literal Path prefix is illustrated; arbitrary Spring patterns need the gateway.
  if (!/^[/A-Za-z0-9._-]*$/.test(prefix)) return null
  return prefix + '/123'
}
export function rewriteExample(route: RouteRule): { before: string; after: string } | null {
  const before = matchingExample(route)
  if (!before) return null
  if (!route.rewriteEnabled) return { before, after: before }
  const prefix = route.path.slice(0, -3)
  const quoted = '^\\Q' + prefix + '\\E/(?<segment>.*)$'
  const literal = '^' + prefix + '/(?<segment>.*)$'
  if (route.rewriteRegex !== quoted && route.rewriteRegex !== literal) return null
  const replacement = route.rewriteReplacement
  // Explicitly support the existing named-segment examples, not a Java-regex emulator.
  if (!replacement || !/^\/[A-Za-z0-9/._-]*\$\{segment\}$/.test(replacement) || replacement.startsWith('//')) return null
  return { before, after: replacement.replace('${segment}', '123') }
}
