import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHandler } from './handler.mjs';
import { createDailyLimit } from './limit.mjs';
import worker from './worker.mjs';

const config = JSON.parse(await readFile(new URL('config.json', import.meta.url), 'utf8'));
const secrets = new SecretsManagerClient({ region: config.region, maxAttempts: 2 });
const limits = new DynamoDBClient({ region: config.region, maxAttempts: 2 });
let cachedKey;
let expiresAt = 0;
let loading;

async function loadKey() {
  if (Date.now() < expiresAt) return cachedKey;
  if (!loading) {
    loading = (async () => {
      const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.secretArn }), {
        abortSignal: AbortSignal.timeout(5000),
      });
      const text = secret.SecretString?.trim();
      const key = text?.startsWith('{') ? JSON.parse(text).OPENAI_API_KEY?.trim() : text;
      if (!key) throw new Error('Missing OpenAI runtime secret.');
      cachedKey = key;
      expiresAt = Date.now() + 300_000;
      return key;
    })().finally(() => { loading = undefined; });
  }
  return loading;
}

const handler = createHandler(config, worker, { loadKey, reserveInterpretation: createDailyLimit(limits, config) });
createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers(incoming.headers);
    const { method } = incoming;
    const url = new URL(incoming.url, config.origin);
    if (url.origin !== config.origin) {
      outgoing.writeHead(400).end('Invalid request URL.');
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming), duplex: 'half' };
    const response = await handler(new Request(url, { method, headers, ...body }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), outgoing);
    else outgoing.end();
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'Cache-Control': 'no-store' }).end('TerraPhase could not complete the request.');
    else outgoing.destroy();
  }
}).listen(3000, '0.0.0.0');
