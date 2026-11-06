// Best-effort log hygiene, not a substitute for the later secret scanner.
export function redact(text: string): string {
  let result = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key) && value && value.length >= 8) result = result.split(value).join('[REDACTED]');
  }
  return result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}

/** Safe structured diagnostics; credentials belong in the environment/credential store, never config. */
export function redactForDiagnostics(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const sensitive = /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|CREDENTIAL)/i;
  const secrets = Object.entries(env).filter(([key, value]) => sensitive.test(key) && !!value).map(([, value]) => value!);
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') {
      let output = input;
      for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
      return output.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]').replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    }
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input !== 'object') return '[UNSUPPORTED]';
    if (depth > 20 || seen.has(input)) return '[OMITTED]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, sensitive.test(key) ? '[REDACTED]' : visit(item, depth + 1)]));
  };
  return visit(value, 0);
}
