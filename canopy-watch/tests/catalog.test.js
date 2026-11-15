import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { listEvents, filterEvents, eventLink } from '../web/comparison/events.js';
test('type and search intersect; accents and empty results work', async () => {
 const events=await listEvents();
 assert.equal(filterEvents(events,'all').length,9);
 assert.equal(filterEvents(events,'drought').length,3);
 assert.equal(filterEvents(events,'forest-disturbance').length,2);
 assert.deepEqual(filterEvents(events,'drought','Louisiana').map(e=>e.id),['louisiana-drought']);
 assert.equal(filterEvents(events,'drought','Brazil').length,0);
 assert.equal(filterEvents(events,'forest-disturbance','Rondonia').length,1);
 assert.equal(filterEvents(events,'all','no such site').length,0);
});
test('deep links and back preserve type and search; old IDs still resolve',async()=>{
 for(const event of await listEvents()){
 const params=new URLSearchParams('type=drought&q=Louisiana');
 const link=new URL(eventLink(event,params),'https://example.test');
 assert.equal(link.searchParams.get('event'),event.id);assert.equal(link.searchParams.get('type'),'drought');
 const back=new URL(eventLink(event,link.searchParams,true),'https://example.test');
 assert.equal(back.searchParams.get('selected'),event.id);assert.equal(back.searchParams.get('q'),'Louisiana');
 assert.equal(back.searchParams.has('event'),false);assert.equal(event.capabilities.forecast,['drought','flood'].includes(event.type));
 }
});

test('each hazard has local repeat-track radar, comparable dates, and an elevation grid', async () => {
 const entries = (await listEvents()).filter(event => event.workspace === 'hazard');
 assert.deepEqual(entries.map(entry => entry.type).sort(), ['earthquake', 'flood', 'landslide', 'volcano']);
 const local = route => new URL('../web' + route, import.meta.url);
 for (const event of entries) {
  const data = JSON.parse(await readFile(local(event.manifestPath)));
  assert.equal(data.id, event.id);
  assert.equal(data.scenes[0].date, event.beforeDate);
  assert.equal(data.scenes.at(-1).date, event.afterDate);
  assert.equal(new Set(data.scenes.map(scene => scene.track + scene.orbit)).size, 1);
  assert.equal(data.outlook.kind, event.capabilities.forecast ? 'model' : 'monitoring');
  const terrain = JSON.parse(await readFile(local(data.terrainPath)));
  assert.equal(terrain.elevation.length, terrain.size * terrain.size);
  assert.ok(terrain.elevation.every(Number.isFinite));
  for (const [index, scene] of data.scenes.entries()) {
   assert.equal((await readFile(local(scene.path))).toString('ascii', 8, 12), 'WEBP');
   if (index) {
    assert.ok(scene.date > data.scenes[index - 1].date && scene.change.coveragePct > 60);
    assert.equal((await readFile(local(scene.changePath))).toString('ascii', 8, 12), 'WEBP');
   }
  }
  if (data.reference) assert.equal((await readFile(local(data.reference.path))).toString('ascii', 8, 12), 'WEBP');
 }
 const stage = JSON.parse(await readFile(local('/hazards/guadalupe-river-flood/outlook.json')));
 assert.equal(stage.horizonMinutes, 60);
 assert.ok(stage.heldOut.years[0] > stage.validation.years.at(-1));
 assert.ok(stage.replay.some(row => row.predictedFt !== null && row.predictedFt !== row.persistenceFt));
 for (let i = 4; i < stage.replay.length; i++) {
  const row = stage.replay[i];
  const prev = stage.replay[i - 4];
  assert.equal(Date.parse(row.utc) - Date.parse(prev.utc), 3600000);
  if (row.persistenceFt !== null) assert.equal(row.persistenceFt, prev.observedFt);
 }
});
test('real drought manifest has reproducible seasonal anomalies and honest units',async()=>{
 const base=new URL('../web/drought/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('louisiana.json',base)));
 const raw=await readFile(new URL('noaa-1609-precipitation.json',base));const data=JSON.parse(raw).data;
 const rain=manifest.layers[1];assert.equal(rain.units,'mm');assert.equal(manifest.layers[0].units,'dB');
 assert.equal(createHash('sha256').update(raw).digest('hex'),rain.sourceSha256);
 for(const row of rain.series){
 const month=row.month.slice(5);const normal=Array.from({length:30},(_,i)=>data[(1991+i)+month].value).reduce((a,b)=>a+b)/30;
 assert.ok(Math.abs(row.anomalyMm-(data[row.month.replace('-','')].value-normal)*25.4)<.001);
 }
 assert.equal(manifest.status,'provisional');assert.ok(rain.series.some(r=>r.anomalyMm<0));
});

test('NISAR browse drought cases have on-disk matched scene pairs and reproducible rainfall', async () => {
 const web = new URL('../web/', import.meta.url);
 const events = (await listEvents()).filter(event => event.evidenceLayers?.includes('gcov-browse'));
 assert.equal(events.length, 2);
 for (const event of events) {
  const manifest = JSON.parse(await readFile(new URL(event.manifestPath.slice(1), web)));
  const [radar, rain] = manifest.layers;
  assert.equal(event.id, manifest.id);
  assert.equal(radar.presentation, 'official-browse');
  assert.equal(radar.units, 'display intensity');
  assert.deepEqual(radar.dates, [event.beforeDate, event.afterDate]);
  assert.deepEqual(radar.scenes.map(scene => scene.date.slice(0, 10)), radar.dates);
  const geometry = scene => scene.id.split('_').slice(5, 11);
  assert.deepEqual(geometry(radar.scenes[0]), geometry(radar.scenes[1]));
  for (const scene of radar.scenes) {
   assert.ok(scene.scienceUrl.endsWith(scene.id + '.h5'));
   for (const band of ['HH', 'HV']) {
    const image = scene.bands[band];
    const file = await readFile(new URL(image.path.slice(1), web));
    assert.equal(file.toString('ascii', 8, 12), 'WEBP');
    assert.match(image.sourceSha256, /^[a-f0-9]{64}$/);
   }
  }
  const raw = await readFile(new URL(rain.rawPath.slice(1), web));
  assert.equal(createHash('sha256').update(raw).digest('hex'), rain.sourceSha256);
  const { data } = JSON.parse(raw);
  for (const row of rain.series) {
   const month = row.month.slice(5);
   const normal = Array.from({ length: 30 }, (_, i) => Number(data[(1991 + i) + month].value))
     .reduce((sum, value) => sum + value, 0) / 30;
   assert.ok(Math.abs(row.anomalyMm - (Number(data[row.month.replace('-', '')].value) - normal) * 25.4) < .001);
  }
 }
});


test('each drought outlook identifies its historical source and reports held-out skill', async () => {
 const events = (await listEvents()).filter(event => event.type === 'drought');
 for (const event of events) {
  const path = event.manifestPath.replace(/\.json$/, '-outlook.json');
  const outlook = JSON.parse(await readFile(new URL('../web' + path, import.meta.url)));
  const raw = await readFile(new URL('../pipeline/drought/noaa-history/' + outlook.division + '.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), outlook.source.sha256);
  assert.equal(outlook.eventId, event.id);
  assert.equal(outlook.backtest.months, 180);
  assert.ok(outlook.through < outlook.target && outlook.probability >= 0 && outlook.probability <= 1);
  const range = outlook.rainfallRange;
  assert.deepEqual(range.observed.at(-1), { month: outlook.through, cumulativeMm: outlook.priorTwoMonthsMm });
  assert.ok(outlook.priorTwoMonthsMm <= range.lowMm && range.lowMm <= range.medianMm && range.medianMm <= range.highMm);
  if (outlook.model === 'logistic') {
   assert.ok(outlook.validation.logisticBrier < outlook.validation.baselineBrier);
  } else {
   assert.ok(outlook.validation.baselineBrier <= outlook.validation.logisticBrier);
   assert.equal(outlook.probability, outlook.baselineProbability);
  }
 }
});
