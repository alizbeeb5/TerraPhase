import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import './build.mjs';

const { default: worker } = await import('../dist/server/index.js');
const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const port = Number(argument('--port') ?? process.env.PORT ?? 3000);
const host = argument('--host') ?? process.env.HOST ?? '127.0.0.1';
createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method;
    const headers = new Headers(incoming.headers);
    headers.delete('oai-authenticated-user-id');
    headers.set('oai-authenticated-user-id', 'local-preview');
    const url = new URL(incoming.url, 'http://' + headers.get('host'));
    const body = method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming), duplex: 'half' };
    const response = await worker.fetch(new Request(url, { method, headers, ...body }), process.env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500).end('Canopy Watch preview failed.');
  }
}).listen(port, host);
