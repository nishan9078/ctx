import http from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = JSON.parse(await readFile(process.env.HARNESS_MOCK_ROUTES ?? '/mock/routes.json', 'utf8'));
const server = http.createServer((request, response) => {
  request.resume();
  if (request.url === '/__harness_health' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ready","mock":true}'); return;
  }
  const route = routes.find(item => item.method === request.method && item.path === request.url);
  response.writeHead(route?.status ?? 404, { 'content-type': 'application/json', 'x-harness-mock': 'true' });
  response.end(JSON.stringify(route?.body ?? { error: 'No configured mock route' }));
});
server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 32;
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => process.send?.({ port: server.address().port }));
