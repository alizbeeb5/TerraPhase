import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { listEvents, filterEvents, eventLink } from '../web/comparison/events.js';
test('type and search intersect; accents and empty results work', async () => {
 const events=await listEvents();
 assert.equal(filterEvents(events,'all').length,3);
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
 assert.equal(back.searchParams.has('event'),false);assert.equal(event.capabilities.forecast,false);
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
