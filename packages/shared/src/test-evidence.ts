export function verifyTestSummary(output: string, format: 'tap' | 'pytest', minimum: number): { passed: boolean; reason: string } {
  if (format === 'tap') {
    const count = (field: string) => { const values = [...output.matchAll(new RegExp(`^#\\s*${field}\\s+(\\d+)\\s*$`, 'gm'))]; return values.length ? Number(values.at(-1)![1]) : undefined; };
    const tests = count('tests'); const pass = count('pass');
    const passed = tests !== undefined && tests >= minimum && pass === tests && count('fail') === 0 && (count('skipped') ?? 0) === 0 && (count('cancelled') ?? 0) === 0 && (count('todo') ?? 0) === 0;
    return { passed, reason: `Independent TAP summary: tests=${tests ?? 'missing'}, pass=${pass ?? 'missing'}, minimum=${minimum}; skipped/cancelled/todo must be zero.` };
  }
  const pass = /\b(\d+) passed\b/.exec(output); const passed = !!pass && Number(pass[1]) >= minimum && !/\b[1-9]\d* (?:failed|skipped|deselected|xfailed|xpassed|errors?)\b/.test(output);
  return { passed, reason: `Independent pytest summary: passed=${pass?.[1] ?? 'missing'}, minimum=${minimum}; failures/skips/deselections are forbidden.` };
}
