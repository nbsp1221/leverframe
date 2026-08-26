const MAX_FAILURE_BYTES = 16 * 1024;

export function redactFailureExcerpt(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const redacted = redactSensitiveText(value, environment);
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= MAX_FAILURE_BYTES) {
    return redacted;
  }
  let excerpt = bytes.subarray(bytes.byteLength - MAX_FAILURE_BYTES).toString('utf8');
  while (Buffer.byteLength(excerpt, 'utf8') > MAX_FAILURE_BYTES) {
    excerpt = excerpt.slice(1);
  }
  return excerpt;
}

export function redactSensitiveText(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = value
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(/\b(?:eyJ[a-zA-Z0-9_-]+\.){2}[a-zA-Z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED_TOKEN]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(
      /(["']?\b(?:[A-Za-z0-9]+[_.-])*(?:secret|token|key|password|credential)(?:[_.-][A-Za-z0-9]+)*["']?\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi,
      '$1[REDACTED]',
    );
  for (const [key, secret] of Object.entries(environment)) {
    if (secret && /(?:secret|token|key|password|credential)/i.test(key) && secret.length >= 4) {
      redacted = redacted.replaceAll(secret, '[REDACTED]');
    }
  }
  return redacted;
}

export const FAILURE_EXCERPT_MAX_BYTES = MAX_FAILURE_BYTES;
