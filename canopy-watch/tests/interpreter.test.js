import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const assetPaths = ['/louisiana-screening.json', '/canopy-watch-louisiana.json', '/rondonia/comparison.json', '/louisiana/outlook.json',
  '/drought/north-florida.json', '/drought/north-florida-outlook.json', '/hazards/krasheninnikov-eruption/comparison.json',
  '/hazards/guadalupe-river-flood/comparison.json', '/hazards/guadalupe-river-flood/outlook.json', '/hazards/map-sites.json'];
const ASSETS = Object.fromEntries(await Promise.all(assetPaths.map(async path => [path,
  ['application/json', (await readFile(new URL('../web' + path, import.meta.url))).toString('base64')]])));
const screening = (await readFile(new URL('../web/screening.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const interpreter = await readFile(new URL('../worker/interpreter.js', import.meta.url), 'utf8');
const worker = (await readFile(new URL('../worker/index.js', import.meta.url), 'utf8')).replace('export default', 'globalThis.worker =');
const answer = { observation: 'Measured change.', explanation: 'Candidate only.', alternatives: ['Moisture.'], verification: ['Inspect optical imagery.'] };
const createWorker = (fetch) => {
  const context = vm.createContext({ ASSETS, Response, Request, URL, TextDecoder, Uint8Array, atob, AbortSignal, console, fetch });
  vm.runInContext(screening + '\n' + interpreter + '\n' + worker, context); return context.worker;
};
const request = (body, headers = {}) => new Request('https://canopy.example/api/interpret', {
  method: 'POST', headers: { Origin: 'https://canopy.example', 'Content-Type': 'application/json', 'oai-authenticated-user-id': 'test-user', ...headers }, body: JSON.stringify(body),
});
const env = { OPENAI_API_KEY: 'test-only-never-a-real-key' };

test('server derives Louisiana evidence from trusted data, ignores injected measurements', async () => {
  let evidence;
  const api = createWorker(async (_url, options) => {
    evidence = JSON.parse(JSON.parse(options.body).input);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
  });
  const data = JSON.parse(Buffer.from(ASSETS['/louisiana-screening.json'][1], 'base64'));
  const module = await import('../web/screening.js');
  const result = module.screenForest(module.decodeScreening(data));
  const response = await api.fetch(request({ eventId: 'louisiana', patchId: result.patches[0].id, dropDb: 3, minimumHa: 1, areaHa: 999999 }), env);
  assert.equal(response.status, 200);
  assert.equal(evidence.patch.areaHa, result.patches[0].areaHa);
  assert.equal(evidence.summary.candidateDisturbanceHa, result.flaggedHa);
  assert.equal(evidence.thresholdMarginDb, .06);
  assert.match(evidence.scope, /not confirmed deforestation/);
});
test('stable control has explicit non-loss scope in AI evidence', async () => {
  let evidence;
  const api = createWorker(async (_url, options) => {
    evidence = JSON.parse(JSON.parse(options.body).input);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
  });
  assert.equal((await api.fetch(request({ eventId: 'rondonia', patchId: 2 }), env)).status, 200);
  assert.match(evidence.scope, /do not count its area as forest loss/);
});
test('missing key, invalid selection, cross origin and unsigned requests do not call OpenAI', async () => {
  const api = createWorker(() => { throw Error('Must not call provider'); });
  const selection = { eventId: 'rondonia', patchId: 1 };
  assert.equal((await api.fetch(request(selection), {})).status, 503);
  assert.equal((await api.fetch(request(selection, { Origin: 'https://other.example' }), env)).status, 403);
  assert.equal((await api.fetch(request(selection, { 'oai-authenticated-user-id': '' }), env)).status, 401);
  assert.equal((await api.fetch(request({ eventId: 'rondonia', patchId: 999 }), env)).status, 404);
  assert.equal((await api.fetch(request({ eventId: 'louisiana', patchId: 1, dropDb: 100, minimumHa: 1 }), env)).status, 400);
});
test('provider outage and incomplete answer return recoverable errors', async () => {
  const body = { eventId: 'rondonia', patchId: 1 };
  const api = createWorker(async () => Response.json({ error: 'provider detail must not leak' }, { status: 429 }));
  const response = await api.fetch(request(body), env);
  assert.equal(response.status, 429); assert.doesNotMatch(await response.text(), /provider detail/);
  const incomplete = createWorker(async () => Response.json({ status: 'incomplete', output: [] }));
  assert.equal((await incomplete.fetch(request(body), env)).status, 502);
});

test('event reports accept no patch, use trusted scene evidence and require response actions', async () => {
  let evidence;
  const api = createWorker(async (_url, options) => {
    const body = JSON.parse(options.body);
    evidence = JSON.parse(body.input);
    assert.ok(body.text.format.schema.required.includes('actions'));
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text',
      text: JSON.stringify({ ...answer, actions: ['Share the verified footprint with the land manager.'] }) }] }] });
  });
  const response = await api.fetch(request({ eventId: 'rondonia', scope: 'event', patchId: null, summary: 'injected' }), env);
  assert.equal(response.status, 200);
  assert.equal(evidence.reportScope, 'event');
  assert.equal(evidence.comparedFootprints.length, 2);
  assert.ok(evidence.sceneIds[0].startsWith('S1'));
  assert.equal(evidence.summary, undefined);
  assert.equal((await api.fetch(request({ eventId: 'rondonia', scope: 'event', patchId: 2 }), env)).status, 400);
});

test('Louisiana reports get their local outlook independently of NISAR candidate evidence', async () => {
  let evidence;
  const api = createWorker(async (_url, options) => {
    evidence = JSON.parse(JSON.parse(options.body).input);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text',
      text: JSON.stringify({ ...answer, actions: ['Review subsequent imagery.'] }) }] }] });
  });
  const response = await api.fetch(request({ eventId: 'louisiana', scope: 'event', patchId: null,
    dropDb: 3, minimumHa: 1 }), env);
  assert.equal(response.status, 200);
  assert.equal(evidence.outlook.model, 'Distance to recent mapped loss');
  assert.equal(evidence.outlook.localHeldOut.length, 3);
  assert.match(evidence.outlook.evidenceSeparation, /independent annual Landsat-derived/);
  assert.match(evidence.independentEvidence, /No independent forest-loss confirmation/);
});

test('whole-event drought reports use trusted rainfall and outlook without forest metrics', async () => {
  let payload;
  const api = createWorker(async (_url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text',
      text: JSON.stringify({ ...answer, actions: ['Check a local rain gauge.'] }) }] }] });
  });
  const selection = { eventId: 'north-florida-drought', scope: 'event', rainfall: { invented: true } };
  assert.equal((await api.fetch(request(selection), env)).status, 200);
  const evidence = JSON.parse(payload.input);
  assert.equal(evidence.topic, 'drought');
  assert.equal(evidence.radar.units, 'display intensity');
  assert.equal(evidence.rainfall.months.length, 4);
  assert.equal(evidence.outlook.division, '0802');
  assert.equal(evidence.rainfall.invented, undefined);
  assert.match(payload.instructions, /separate display scaling/);
  assert.equal((await api.fetch(request({ ...selection, scope: 'patch', patchId: 1 }), env)).status, 400);
});

test('hazard reports verify the chosen date and use packaged evidence and outlook', async () => {
  let payload;
  const api = createWorker(async (_url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text',
      text: JSON.stringify({ ...answer, actions: ['Review the next matched pass.'] }) }] }] });
  });
  const selection = { eventId: 'krasheninnikov-eruption', scope: 'event', comparisonDate: '2026-07-09',
    radarChange: { medianDb: 9000 } };
  assert.equal((await api.fetch(request(selection), env)).status, 200);
  const evidence = JSON.parse(payload.input);
  assert.equal(evidence.topic, 'hazard');
  assert.equal(evidence.outlook.kind, 'monitoring');
  assert.equal(evidence.map.kind, 'monitoring');
  assert.equal(evidence.acquisitions[1].date, selection.comparisonDate);
  assert.notEqual(evidence.radarChange.medianDb, selection.radarChange.medianDb);
  assert.match(payload.instructions, /Do not predict earthquakes or eruptions/);
  assert.equal((await api.fetch(request({ ...selection, comparisonDate: '2026-01-01' }), env)).status, 404);
  assert.equal((await api.fetch(request({ ...selection, scope: 'patch', patchId: 1 }), env)).status, 400);
  assert.equal((await api.fetch(request({ eventId: 'guadalupe-river-flood', scope: 'event' }), env)).status, 200);
  assert.equal(JSON.parse(payload.input).replay.horizonMinutes, 60);
});
