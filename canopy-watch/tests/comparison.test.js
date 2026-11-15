import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateComparison, commonMask, areaSummary, clampExtent, zoomExtent } from '../web/comparison/core.js';
import { decodeScreening, screenForest } from '../web/screening.js';
import { listEvents } from '../web/comparison/events.js';

const readJSON = async path => JSON.parse(await readFile(new URL(path, import.meta.url)));
const louisiana = await readJSON('../web/canopy-watch-louisiana.json');
const rondonia = await readJSON('../web/rondonia/comparison.json');
const source = await readJSON('../web/louisiana-screening.json');
const fixture = (width = 4, height = 4) => ({ grid: { width, height, spacingM: 100, bounds: [0, 0, width * 100, height * 100] },
  cover: new Uint8Array(width * height).fill(10), HH: new Uint8Array(width * height).fill(127),
  HV: new Uint8Array(width * height).fill(127) });

test('both real event packages pass acquisition/grid checks', () => {
  assert.equal(validateComparison(louisiana), louisiana);
  assert.equal(validateComparison(rondonia), rondonia);
});
test('reject incompatible pass, orbit, polarization, reversed dates and misaligned grid', () => {
  for (const key of ['pass', 'track', 'frame', 'polarization', 'release']) {
    const data = structuredClone(louisiana); data.scenes[1][key] = 'wrong';
    assert.throws(() => validateComparison(data), /Incompatible acquisition/);
  }
  const orbit = structuredClone(rondonia); orbit.scenes[1].orbit++;
  assert.throws(() => validateComparison(orbit), /orbit/);
  const dates = structuredClone(louisiana); dates.scenes.reverse();
  assert.throws(() => validateComparison(dates), /Before must precede/);
  const bounds = structuredClone(louisiana); bounds.grid.spacingM = 20;
  assert.throws(() => validateComparison(bounds), /do not align/);
});
test('empty coverage and malformed grid fail before rendering', () => {
  const data = structuredClone(louisiana); data.layers.HV.validPct = 0;
  assert.throws(() => validateComparison(data), /No usable shared coverage/);
  data.grid.width = 0; assert.throws(() => validateComparison(data), /Invalid comparison grid/);
});
test('common mask distinguishes missing/partial pixels from valid unchanged pixels', () => {
  const pixels = alphas => Uint8Array.from(alphas.flatMap(a => [39, 46, 54, a]));
  const result = commonMask(pixels([255, 255, 0, 255]), pixels([255, 0, 255, 255]), pixels([255, 255, 255, 128]));
  assert.deepEqual([...result.mask], [1, 0, 0, 0]); assert.equal(result.cells, 1);
  assert.throws(() => commonMask(pixels([0]), pixels([0]), pixels([0])), /no shared valid/);
});
test('screening inputs belong to the exact bundled comparison', async () => {
  const bytes = await readFile(new URL('../web/canopy-watch-louisiana.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.comparisonSha256);
  assert.deepEqual(decodeScreening(source).grid, louisiana.grid);
});
test('8-neighbor connectivity joins diagonal forest cells without row wrapping', () => {
  const data = fixture(); data.HV[0] = 40; data.HV[5] = 40; data.HV[15] = 40;
  const result = screenForest(data, 3, 2);
  assert.equal(result.patches.length, 1); assert.equal(result.patches[0].cells, 2);
  assert.deepEqual(result.patches[0].box, [0, 0, 2, 2]); assert.equal(result.flaggedHa, 2);
  const wrap = fixture(); wrap.HV[3] = 40; wrap.HV[4] = 40;
  assert.equal(screenForest(wrap, 3, 2).patches.length, 0);
});
test('nodata and nonforest are excluded; area uses valid forest denominator', () => {
  const data = fixture(); data.HV.fill(40); data.HV[0] = 255; data.cover[1] = 80;
  const result = screenForest(data, 3, 1);
  assert.equal(result.forestHa, 14); assert.equal(result.flaggedHa, 14); assert.equal(result.flaggedForestPct, 100);
});
test('raw numerical changes remain unclipped and exact-threshold cells qualify', () => {
  const data = fixture(2, 2); data.numeric = { HH: Float32Array.of(-12, -1, NaN, 0), HV: Float32Array.of(-12, -3, NaN, 0) };
  const result = screenForest(data, 3, 1);
  assert.equal(result.flaggedHa, 2); assert.equal(result.patches[0].hvDb, -7.5);
  assert.equal(result.thresholdMarginDb, 0); assert.equal(result.forestHa, 3);
});
test('decode raw float32 little-endian values and reject truncated numerical grids', () => {
  const pack = values => { const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeFloatLE(v, i * 4)); return bytes.toString('base64'); };
  const data = { schema: source.schema, grid: fixture(2, 2).grid,
    cover: Buffer.from([10, 10, 10, 10]).toString('base64'), HH: Buffer.alloc(4, 127).toString('base64'), HV: Buffer.alloc(4, 127).toString('base64'),
    numeric: { encoding: 'float32-le-base64', HH: pack([-12, 0, NaN, 3]), HV: pack([-12, -3, NaN, 0]) } };
  assert.equal(screenForest(decodeScreening(data), 3, 1).flaggedHa, 2);
  data.numeric.HH = pack([1]); assert.throws(() => decodeScreening(data), /dimensions do not match/);
});
test('display estimates apply quantization margin and reject unsupported settings', () => {
  const data = fixture(); data.HV.fill(79); // -3.0236 dB, inside the ambiguity margin.
  assert.equal(screenForest(data, 3, 1).flaggedHa, 0);
  assert.throws(() => screenForest(data, NaN, 1)); assert.throws(() => screenForest(data, 3, 0));
});
test('real screening area exactly matches retained labels; stricter settings cannot add area', () => {
  const data = decodeScreening(source); const normal = screenForest(data);
  assert.ok(normal.patches.length > 0);
  assert.equal([...normal.labels].filter(Boolean).length * .01, normal.flaggedHa);
  assert.ok(screenForest(data, 5, 1).flaggedHa <= normal.flaggedHa);
  assert.ok(screenForest(data, 3, 3).flaggedHa <= normal.flaggedHa);
  assert.deepEqual(screenForest(data).patches, normal.patches);
});
test('curated summary excludes stable control and does not claim exhaustive loss', () => {
  const result = areaSummary(1000, rondonia.grid, { patches: rondonia.patches }, true);
  assert.equal(result.flaggedHa, 8.24); assert.equal(result.exhaustive, false);
  assert.equal(result.analyzedHa, 40); assert.ok(Math.abs(result.flaggedPct - 20.6) < 1e-9);
});
test('empty forest produces a safe empty result, not a confidence score or NaN', () => {
  const data = fixture(); data.cover.fill(80); const result = screenForest(data);
  assert.equal(result.flaggedForestPct, null); assert.equal(result.patches.length, 0);
  assert.equal(areaSummary(16, data.grid, result).flaggedPct, 0);
});
test('zoom and pan clamp to raster; anchor remains stable away from edges', () => {
  const grid = { width: 1000, height: 600 };
  assert.deepEqual(clampExtent([-20, 800, 200, 100], grid), [0, 500, 200, 100]);
  const extent = zoomExtent([0, 0, 1000, 600], .5, grid, [.25, .5]);
  assert.deepEqual(extent, [125, 150, 500, 300]);
  assert.deepEqual(zoomExtent(extent, 100, grid), [0, 0, 1000, 600]);
});
test('globe contract provides stable IDs, dates, locations and isolated objects', async () => {
  const events = await listEvents();
  const ids = new Set(events.map(event => event.id));
  assert.equal(ids.size, events.length);
  assert.ok(['rondonia', 'louisiana', 'louisiana-drought'].every(id => ids.has(id)));
  events[0].center.lat = 0; assert.notEqual((await listEvents())[0].center.lat, 0);
  assert.ok(events.every(e => ['ready', 'provisional'].includes(e.status) && e.beforeDate < e.afterDate));
});
