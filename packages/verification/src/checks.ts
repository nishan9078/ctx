import { parse, type DefaultTreeAdapterMap } from 'parse5';
import ts from 'typescript';
import { readFile, writeFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { join, extname, relative, isAbsolute, sep } from 'node:path';
import { runProcess, type ProcessResult } from '../../environment/src/process-manager.js';
import { safeRelativePath } from './policy.js';
export async function safeArtifactPath(workspace: string, path: string): Promise<string> {
  if (!safeRelativePath(path)) throw new Error(`Unsafe artifact path: ${path}`);
  let target = workspace;
  for (const part of path.split('/')) { target = join(target, part); if ((await lstat(target)).isSymbolicLink()) throw new Error(`Symbolic link refused: ${path}`); }
  const actual = await realpath(target); const rel = relative(await realpath(workspace), actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Artifact escapes workspace: ${path}`);
  return actual;
}
export async function artifactsCheck(workspace: string, paths: string[], absentPaths: string[] = []): Promise<{ passed: boolean; output: string }> {
  if (!paths.length && !absentPaths.length) return { passed: false, output: 'No changed or required artifacts exist. Agent claims alone cannot satisfy verification.\n' };
  let passed = true; const output: string[] = [];
  for (const path of paths) {
    try { const info = await lstat(await safeArtifactPath(workspace, path)); if (!info.isFile() || !info.size) throw new Error('Expected a nonempty regular file'); output.push(`PASS artifact: ${path} (${info.size} bytes)`); }
    catch (error) { passed = false; output.push(`FAIL artifact: ${path}: ${(error as Error).message}`); }
  }
  for (const path of absentPaths) { if (!safeRelativePath(path)) throw new Error('Unsafe deletion path'); try { await lstat(join(workspace, path)); passed = false; output.push(`FAIL deletion: ${path} still exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; output.push(`PASS deletion: ${path} is absent`); } }
  return { passed, output: output.join('\n') + '\n' };
}
export function syntaxEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_SANDBOX'];
  return Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
export async function syntaxCheck(workspace: string, paths: string[], directory: string, signal?: AbortSignal, execute: typeof runProcess = runProcess): Promise<{ passed: boolean; unavailable: boolean; output: string }> {
  await mkdir(join(directory, 'syntax-inputs'), { recursive: true });
  let passed = true; let unavailable = false; const output: string[] = []; let count = 0;
  async function javascript(source: string, module: boolean, label: string) {
    const artifact = join(directory, 'syntax-inputs', `${++count}${module ? '.mjs' : '.cjs'}`); await writeFile(artifact, source);
    const result = await execute(process.execPath, ['--check', artifact], workspace, { signal, timeoutMs: 15_000, env: syntaxEnvironment() });
    passed &&= result.code === 0 && !result.timedOut;
    output.push(`${label}\ncommand: ${JSON.stringify([process.execPath, '--check', artifact])}\nexit: ${result.code}\n${result.output || 'Syntax accepted (code was not executed).'}\n`);
  }
  async function visit(node: DefaultTreeAdapterMap['node'], path: string): Promise<void> {
    if ('tagName' in node) {
      const attrs = Object.fromEntries(node.attrs.map(attribute => [attribute.name, attribute.value]));
      for (const [name, value] of Object.entries(attrs)) if (/^on[a-z]+$/i.test(name)) await javascript(`function eventHandler(event) {\n${value}\n}`, false, `${path}: ${name}`);
      if (node.tagName === 'script') {
        const type = (attrs.type ?? '').toLowerCase().split(';')[0].trim();
        const script = node.childNodes.filter(child => child.nodeName === '#text').map(child => 'value' in child ? child.value : '').join('');
        if (attrs.src) {
          if (/^(?:https?:)?\/\//i.test(attrs.src) || /^[a-z]+:/i.test(attrs.src)) output.push(`${path}: external script ${attrs.src} not fetched; its content and runtime behavior are unverified.`);
          else { const target = join(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', attrs.src.split(/[?#]/)[0]); await javascript(await readFile(await safeArtifactPath(workspace, target), 'utf8'), type === 'module', `${path}: script src ${attrs.src}`); }
        } else if (type === 'module' || !type || ['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) await javascript(script, type === 'module', `${path}: inline script`);
        else if (type === 'application/ld+json' || type === 'application/json' || type === 'importmap') { JSON.parse(script); output.push(`${path}: ${type} JSON syntax accepted`); }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) await visit(child, path);
    if ('content' in node && node.tagName === 'template') await visit(node.content, path);
  }
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      const source = await readFile(await safeArtifactPath(workspace, path), 'utf8');
      if (/\.html?$/i.test(path)) {
        if (!/<(?:!doctype\s+html|html|head|body|canvas|main|div|script)\b/i.test(source)) throw new Error('Expected an HTML document or fragment');
        await visit(parse(source), path); output.push(`${path}: HTML parsed; no browser execution implied.`);
      } else if (/\.[cm]?tsx?$|\.jsx$/i.test(path)) {
        const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
        const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
        if (diagnostics.length) throw new Error(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
        output.push(`${path}: TypeScript/JSX parser accepted syntax. Type checking was not performed by this syntax check.`);
      } else if (/\.[cm]?js$/i.test(path)) {
        let module = extname(path) === '.mjs';
        if (extname(path) === '.js') { let type: string | undefined; try { type = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).type; } catch {} module = type === 'module' || type === undefined && ts.isExternalModule(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)); }
        await javascript(source, module, path);
      } else if (/\.py$/i.test(path)) {
        try { const result = await execute('python3', ['-I', '-S', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), filename=sys.argv[1]); print("Python syntax accepted; no execution")', join(workspace, path)], workspace, { signal, timeoutMs: 15_000, env: syntaxEnvironment() }); passed &&= result.code === 0; output.push(`${path}: python3 ast.parse; exit ${result.code}\n${result.output}`); }
        catch (error) { unavailable = true; passed = false; output.push(`${path}: Python parser unavailable: ${String(error)}`); }
      }
    } catch (error) { passed = false; output.push(`FAIL syntax ${path}: ${(error as Error).message}`); }
  }
  return { passed, unavailable, output: output.join('\n') + '\nSyntax is not browser/gameplay verification.\n' };
}
