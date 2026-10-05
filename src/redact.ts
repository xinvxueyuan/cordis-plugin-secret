/**
 * Defense in depth for every message this plugin surfaces to a model: a value
 * that must never appear in a result, a log line or an error is stripped out.
 */
export function redactSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) continue
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
}
