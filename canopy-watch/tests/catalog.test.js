import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { listEvents, filterEvents, eventLink } from '../web/comparison/events.js';
test('type and search intersect; accents and empty results work', async () => {
 const events=await listEvents();
 assert.equal(filterEvents(events,'all').length,5);
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
 assert.equal(back.searchParams.has('event'),false);assert.equal(event.capabilities.forecast,event.type==='drought');
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
