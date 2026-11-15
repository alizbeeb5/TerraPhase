import test from 'node:test';
import assert from 'node:assert/strict';
import { readBuildConfig } from '../hosting/amplify/config.mjs';
import { createHandler } from '../hosting/amplify/handler.mjs';
import { createDailyLimit } from '../hosting/amplify/limit.mjs';

const origin = 'https://public.example';
const config = readBuildConfig({
  TERRAPHASE_PUBLIC_ORIGIN: origin,
  TERRAPHASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:terraphase/openai-EXAMPL',
  TERRAPHASE_LIMIT_TABLE: 'report-quota',
});

test('Amplify report adapter accepts public same-origin requests and supplies its own server context', async () => {
  let loads = 0;
  const reserveInterpretation = async () => true;
  const adapter = createHandler(config, { fetch: async (request, env) => {
    assert.equal(request.url, origin + '/api/interpret');
    assert.notEqual(request.headers.get('oai-authenticated-user-id'), 'forged');
    assert.equal(request.headers.get('cookie'), null);
    assert.equal((await request.json()).eventId, 'rondonia');
    assert.equal(env.OPENAI_API_KEY, 'dummy-key');
    assert.equal(env.reserveInterpretation, reserveInterpretation);
    return Response.json({ success: true });
  } }, { loadKey: async () => { loads++; return 'dummy-key'; }, reserveInterpretation });
  const report = base => new Request(origin + '/api/interpret/', {
    method: 'POST', headers: { Origin: base, 'oai-authenticated-user-id': 'forged', cookie: 'irrelevant=value' },
    body: JSON.stringify({ eventId: 'rondonia' }),
  });
  assert.equal((await adapter(report('https://external.example'))).status, 403);
  assert.equal((await adapter(new Request(origin + '/api/interpret'))).status, 405);
  assert.equal(loads, 0);
  assert.equal((await adapter(report(origin))).status, 200);
  assert.equal(loads, 1);
});

test('the daily limit uses a conditional update and resets at midnight UTC', async () => {
  let now = Date.parse('2026-11-15T23:59:59Z');
  const keys = [];
  const client = { send: async ({ input }) => {
    keys.push(input.Key.bucket.S);
    assert.equal(input.TableName, 'report-quota');
    assert.equal(input.ExpressionAttributeValues[':limit'].N, '120');
    assert.match(input.ConditionExpression, /#used < :limit/);
    if (keys.length === 2) throw Object.assign(new Error('Full'), { name: 'ConditionalCheckFailedException' });
    if (keys.length === 4) throw new Error('DynamoDB unavailable');
  } };
  const reserve = createDailyLimit(client, config, () => now);
  assert.equal(await reserve(), true);
  assert.equal(await reserve(), false);
  assert.equal(await reserve(), false);
  assert.equal(keys.length, 2);
  now += 1_000;
  assert.equal(await reserve(), true);
  assert.notEqual(keys[2], keys[1]);
  await assert.rejects(reserve, /DynamoDB unavailable/);
});
