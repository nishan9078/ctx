import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const graph = new Map();
const owner = path => relative(root, path).split(sep).slice(0, 2).join('/');
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path); continue; }
    if (!path.endsWith('.ts')) continue;
    const sourceOwner = owner(path);
    if (!graph.has(sourceOwner)) graph.set(sourceOwner, new Set());
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const add = specifier => {
      if (!specifier?.startsWith('.')) return;
      const destination = owner(resolve(dirname(path), specifier));
      if (destination !== sourceOwner) graph.get(sourceOwner).add(destination);
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
await inspect(join(root, 'packages'));
await inspect(join(root, 'apps'));
const visited = new Set(); const active = []; const cycles = [];
function walk(node) {
  if (active.includes(node)) { cycles.push([...active.slice(active.indexOf(node)), node]); return; }
  if (visited.has(node)) return;
  active.push(node);
  for (const dependency of graph.get(node) ?? []) walk(dependency);
  active.pop(); visited.add(node);
}
for (const node of graph.keys()) walk(node);
const sharedDependencies = [...(graph.get('packages/shared') ?? [])];
console.log(JSON.stringify({ includesTypeImports: true, graph: Object.fromEntries([...graph].sort().map(([key, values]) => [key, [...values].sort()])), cycles, sharedDependencies }, null, 2));
if (cycles.length || sharedDependencies.length) process.exitCode = 1;
