// Best-effort log hygiene, not a substitute for the later secret scanner.
export function redact(text: string): string {
  let result = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key) && value && value.length >= 8) result = result.split(value).join('[REDACTED]');
  }
  return result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
}
