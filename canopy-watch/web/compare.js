import { DEFAULT_AREA_HA, DEFAULT_DROP_DB, decodeScreening, screenForest } from './screening.js';

import { events } from './comparison/events.js';
import { validateComparison, commonMask, areaSummary, clampExtent, zoomExtent } from './comparison/core.js';
import { mountControls } from './comparison/controls.js';
import { mountComparisonShell } from './comparison/workspace.js';
import { mountReport, evidenceReport, applyAI, showReport, downloadReport } from './comparison/report.js';
import { mountOutlook, loadOutlook, showOutlook, describeZone } from './comparison/outlook.js';

const $ = id => document.getElementById(id);
mountComparisonShell();
mountControls();
mountReport();
mountOutlook(toggleOutlook, selectRiskZone);
const maps = ['before-map', 'after-map', 'change-map'].map($);
const canvas = $('overlay');
const context = canvas.getContext('2d');
const dates = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const numbers = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const formatDate = value => dates.format(new Date(value));
const formatArea = value => numbers.format(value) + ' ha';
const formatDb = (value, approximate = false) => (approximate ? '≈ ' : '') + value.toFixed(2) + ' dB';
const state = { load: 0, selection: 0, layout: 'split', viewport: null, cursor: null };
const loaded = new Map();
let activeInterpretation;

const details = {
  rondonia: {
    status: 'Hansen annual tree-cover loss + Sentinel-2 imagery',
    credits: 'Copernicus Sentinel-1 / Sentinel-2 · UMD Hansen · Copernicus DEM',
    method: 'The footprint was selected for persistent Sentinel-1 VH decreases and overlap with Hansen annual tree-cover loss. The shown area is the selected radar footprint. Archived radar layers retain the eligible baseline forest cells, so areas masked from the radar analysis are blank. The September repeat pass checks persistence. The cloud-masked August 2022 optical image confirms what the area looked like by that date. These observations do not date the clearing to a single day.',
    sources: [
      ['Sentinel-1 RTC', 'https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc'],
      ['Sentinel-2 L2A', 'https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a'],
      ['Hansen Global Forest Change v1.12', 'https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12/download.html'],
    ],
  },
  louisiana: {
    status: 'Radar candidates · canopy loss unverified',
    credits: 'NASA / ISRO NISAR · Alaska Satellite Facility · ESA WorldCover · USGS 3DEP',
    method: 'The forest screen groups touching HV decreases within areas mapped as tree cover or mangroves in 2021. Candidate dB measurements are approximate because the available change imagery is quantized and clipped at ±8 dB. Flagged area counts radar cells. Moisture and inundation can also change backscatter.',
    sources: [
      ['NISAR GCOV', 'https://nisar-docs.asf.alaska.edu/gcov/'],
      ['ESA WorldCover', 'https://esa-worldcover.org/en/data-access'],
    ],
  },
};

async function readJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw Error('The satellite comparison could not load. Try opening this event again.');
  return response.json();
}

async function image(url, grid) {
  const result = new Image();
  result.src = url;
  await result.decode();
  if (result.width !== grid.width || result.height !== grid.height) throw Error('The imagery grid is invalid.');
  return result;
}

function labelsFrom(image, grid) {
  const layer = document.createElement('canvas');
  layer.width = grid.width;
  layer.height = grid.height;
  const ctx = layer.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, grid.width, grid.height).data;
  return Uint8Array.from({ length: grid.width * grid.height }, (_, index) => pixels[index * 4] / 100);
}

async function loadData(id) {
  const response = await fetch(events[id].path);
  if (!response.ok) throw Error('The satellite comparison could not load. Try opening this event again.');
  const rawComparison = await response.text();
  const data = validateComparison(JSON.parse(rawComparison));
  const { grid } = data;
  if (data.schema !== 'canopy-watch-comparison/v1' || !grid?.width || !grid.height || data.scenes?.length !== 2) {
    throw Error('The comparison metadata is invalid.');
  }
  const images = Object.fromEntries(await Promise.all(Object.entries(data.layers).map(async ([band, layer]) => [
    band, Object.fromEntries(await Promise.all(['before', 'after', 'change'].map(async view => [view, await image(layer[view], grid)]))),
  ])));
  const coverage = {};
  for (const [band, layers] of Object.entries(images)) {
    const pixels = {};
    for (const [name, source] of Object.entries(layers)) {
      const surface = document.createElement('canvas');
      surface.width = grid.width;
      surface.height = grid.height;
      const ctx = surface.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0);
      pixels[name] = ctx.getImageData(0, 0, grid.width, grid.height);
      layers[name] = surface;
    }
    coverage[band] = commonMask(pixels.before.data, pixels.after.data, pixels.change.data);
    for (const [name, pixelsForLayer] of Object.entries(pixels)) {
      for (let i = 0; i < coverage[band].mask.length; i++) {
        if (!coverage[band].mask[i]) pixelsForLayer.data[4 * i + 3] = 0;
      }
      layers[name].getContext('2d').putImageData(pixelsForLayer, 0, 0);
    }
  }
  if (id === 'louisiana') {
    const source = await readJson('/louisiana-screening.json');
    const screen = decodeScreening(source);
    if (JSON.stringify(screen.grid) !== JSON.stringify(grid)) throw Error('The radar and forest screening grids differ.');
    const bytes = new TextEncoder().encode(rawComparison);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== source.comparisonSha256) throw Error('Screening inputs are stale for this comparison. Regenerate the screening package.');
    for (const band of ['HH', 'HV']) {
      for (let i = 0; i < coverage[band].mask.length; i++) {
        if (!coverage[band].mask[i]) { screen[band][i] = 255; if (screen.numeric) screen.numeric[band][i] = NaN; }
      }
    }
    return { data, images, screen, coverage };
  }
  const [before, after, mask, reference] = await Promise.all(
    ['optical-before.webp', 'optical-after.webp', 'patches.png', 'reference.png'].map(name => image('/rondonia/' + name, grid)),
  );
  const labels = labelsFrom(mask, grid);
  const referenceLayer = document.createElement('canvas');
  referenceLayer.width = grid.width;
  referenceLayer.height = grid.height;
  const ctx = referenceLayer.getContext('2d');
  ctx.drawImage(reference, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ba9cf5';
  ctx.fillRect(0, 0, grid.width, grid.height);
  return { data, images, coverage, optical: { before, after }, referenceLayer, result: { patches: data.patches, labels } };
}

function rows(id, entries) {
  $(id).replaceChildren(...entries.flatMap(([name, value]) => {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = name;
    detail.textContent = value;
    return [term, detail];
  }));
}

function activePatch() {
  return state.result?.patches.find(patch => patch.id === state.patchId);
}

function crop() {
  if (state.viewport) return state.viewport;
  const { width, height, spacingM } = state.data.grid;
  const patch = activePatch();
  if (state.focus === 'scene' || !patch) return [0, 0, width, height];
  const [left, top, right, bottom] = patch.box;
  const side = Math.min(width, height, Math.max(Math.ceil(800 / spacingM), 2 * Math.max(right - left, bottom - top)));
  const x = Math.max(0, Math.min(width - side, Math.floor((left + right - side) / 2)));
  const y = Math.max(0, Math.min(height - side, Math.floor((top + bottom - side) / 2)));
  return [x, y, side, side];
}

function drawBoundaries(ctx, extent, emphasize) {
  if (!$('show-boundary').checked || !state.result?.patches.length) return;
  const [left, top, width, height] = extent;
  const stride = state.data.grid.width;
  const fullHeight = state.data.grid.height;
  const labels = state.result.labels;
  ctx.save();
  let color;
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const i = y * stride + x;
      const id = labels[i];
      if (!id || (!emphasize && id !== state.patchId)) continue;
      if (x && y && x < stride - 1 && y < fullHeight - 1
        && labels[i - 1] === id && labels[i + 1] === id && labels[i - stride] === id && labels[i + stride] === id) continue;
      const shade = id === state.patchId ? '#ffe195' : '#a5d046';
      if (color !== shade) ctx.fillStyle = color = shade;
      ctx.fillRect(x - left, y - top, 1, 1);
    }
  }
  ctx.restore();
}

function draw() {
  if (!state.data) return;
  const { data, band, images, mode } = state;
  const terrain = mode === 'terrain';
  const drape = $('drape').value;
  $('overlay').setAttribute('aria-label', band + ' ' + drape + ' draped on elevation');
  $('plate').hidden = terrain;
  $('change-context').hidden = terrain || state.layout !== 'change';
  document.querySelector('.comparison-toolbar').hidden = terrain;
  $('pixel-inspection').hidden = terrain;
  $('plate').dataset.layout = state.layout;
  $('swipe-control').hidden = state.layout !== 'swipe';
  document.querySelectorAll('[data-layout]').forEach(button => button.setAttribute('aria-pressed', button.dataset.layout === state.layout));
  $('terrain-viewport').hidden = !terrain;
  $('terrain-controls').hidden = !terrain;
  $('view-options').hidden = terrain;
  $('reference-option').hidden = !state.referenceLayer;
  const showRisk = Boolean(state.outlook && $('show-outlook').checked);
  const isDelta = !terrain || drape === 'change';
  const range = isDelta ? (data.layers[band].changeRange ?? [-8, 8]) : data.layers[band].range;
  $('scale-min').textContent = range[0] + ' dB';
  $('scale-max').textContent = (range[1] > 0 ? '+' : '') + range[1] + ' dB';
  $('ramp').classList.toggle('delta', isDelta);
  document.querySelector('.map-key').hidden = !terrain && state.layout === 'swipe' && !$('show-change').checked && !showRisk;
  $('backscatter-scale').textContent = mode === 'radar'
    ? 'Before and after share the ' + data.layers[band].range.join(' to ') + ' dB scale.' : '';
  $('key-caption').textContent = isDelta ? 'Cyan decrease · Orange increase'
    + (!terrain && $('show-boundary').checked && activePatch() ? ' · Gold footprint' : '')
    + (!terrain && state.id === 'rondonia' && state.focus === 'scene' ? ' · Checkerboard = no shared radar data' : '')
    + (!terrain && state.referenceLayer && $('show-reference').checked ? ' · Purple mapped loss' : '')
    + (!terrain && showRisk ? ' · Dashed magenta: ' + state.outlook.targetYear + ' monitoring priority' : '') : 'Backscatter';
  if (terrain) {
    drawTerrain(images[band][drape], data.terrain, data.grid);
    return;
  }
  const sources = mode === 'optical' ? state.optical : images[band];
  const observations = mode === 'optical' ? data.optical : data.scenes;
  const sensor = mode === 'optical' ? 'Sentinel-2' : band;
  $('change-context').textContent = 'After − before in dB · ' + (state.id === 'rondonia' ? 'Sentinel-1 ' : 'NISAR ') + band
    + ' · ' + formatDate(data.scenes[0].date) + ' → ' + formatDate(data.scenes[1].date) + '. Colored change alone does not identify its cause.';
  $('before-date').textContent = sensor + ' · ' + formatDate(observations[0].date)
    + (state.layout === 'swipe' ? ' → ' + formatDate(observations[1].date) : '');
  $('after-date').textContent = sensor + ' · ' + formatDate(observations[1].date);
  $('difference-date').textContent = band + ' · ' + formatDate(data.scenes[0].date) + ' → ' + formatDate(data.scenes[1].date);
  const extent = state.extent = clampExtent(crop(), data.grid);
  const [, , width, height] = extent;
  $('map-scale').textContent = numbers.format(width * data.grid.spacingM / 1000) + ' km across each panel';
  const layers = [sources.before, sources.after, images[band].change];
  maps.forEach((map, index) => {
    map.width = width;
    map.height = height;
    const ctx = map.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layers[index], ...extent, 0, 0, width, height);
    if (state.layout === 'swipe' && index === 0) {
      const cut = width * Number($('swipe-position').value) / 100;
      ctx.save(); ctx.beginPath(); ctx.rect(cut, 0, width - cut, height); ctx.clip();
      ctx.drawImage(sources.after, ...extent, 0, 0, width, height); ctx.restore();
      ctx.fillStyle = '#fff'; ctx.fillRect(cut, 0, Math.max(1, width / 400), height);
    }
    if (index < 2 && $('show-change').checked) {
      ctx.globalAlpha = .4; ctx.drawImage(images[band].change, ...extent, 0, 0, width, height); ctx.globalAlpha = 1;
    }
    if (index === 2 && state.referenceLayer && $('show-reference').checked) {
      ctx.globalAlpha = .55;
      ctx.drawImage(state.referenceLayer, ...extent, 0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    if (showRisk && (index > 0 || state.layout === 'swipe')) {
      ctx.save();
      if (index === 0) {
        const cut = width * Number($('swipe-position').value) / 100;
        ctx.beginPath(); ctx.rect(cut, 0, width - cut, height); ctx.clip();
      }
      ctx.drawImage(state.outlook.layer, ...extent, 0, 0, width, height);
      ctx.restore();
    }
    drawBoundaries(ctx, extent, index === 2);
    if (state.cursor) {
      const x = state.cursor[0] - extent[0] + .5, y = state.cursor[1] - extent[1] + .5;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, width / 500);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    map.setAttribute('aria-label', ['Before · ' + $('before-date').textContent,
      'After · ' + $('after-date').textContent, 'Radar difference · ' + band][index]);
    map.classList.toggle('pickable', index === 2 && state.focus === 'scene' && Boolean(state.result?.patches.length));
  });
  if (state.layout === 'swipe') {
    maps[0].setAttribute('aria-label', 'Before left / after right. ' + $('before-date').textContent + ' → ' + $('after-date').textContent);
  }
}

function drawTerrain(image, terrain, grid) {
  canvas.width = 960;
  canvas.height = 570;
  const size = terrain.size;
  const texture = document.createElement('canvas');
  texture.width = size;
  texture.height = size;
  const tex = texture.getContext('2d');
  tex.drawImage(image, 0, 0, size, size);
  const rgba = tex.getImageData(0, 0, size, size).data;
  const angle = Number($('rotation').value) * Math.PI / 180;
  const scale = 650 / Math.hypot(grid.widthM, grid.heightM);
  const center = (Math.min(...terrain.elevation) + Math.max(...terrain.elevation)) / 2;
  const relief = Math.max(...terrain.elevation) - Math.min(...terrain.elevation);
  const vertical = Math.min(scale * Number($('exaggeration').value), 330 / (relief || 1));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const points = terrain.elevation.map((height, i) => {
    const x = (i % size / (size - 1) - .5) * grid.widthM * scale;
    const y = (Math.floor(i / size) / (size - 1) - .5) * grid.heightM * scale;
    const depth = x * s + y * c;
    return { x: 480 + x * c - y * s, y: 290 + depth * .50 - (height - center) * vertical, depth };
  });
  const faces = [];
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const k = j * size + i;
      if (!rgba[k * 4 + 3]) continue;
      const corners = [points[k], points[k + 1], points[k + size + 1], points[k + size]];
      faces.push({ corners, depth: corners.reduce((sum, point) => sum + point.depth, 0), k });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  for (const { corners, k } of faces) {
    const base = k * 4;
    context.fillStyle = context.strokeStyle = 'rgb(' + rgba.slice(base, base + 3).join(',') + ')';
    context.beginPath();
    context.moveTo(corners[0].x, corners[0].y);
    corners.slice(1).forEach(point => context.lineTo(point.x, point.y));
    context.closePath();
    context.stroke();
    context.fill();
  }
}

function reportPatch() {
  return $('report-scope').value === 'patch' ? activePatch() : null;
}

function resetReport() {
  state.selection++;
  activeInterpretation?.abort();
  $('interpret-status').textContent = '';
  const patch = activePatch();
  $('report-scope').options[1].disabled = !patch;
  if (!patch) $('report-scope').value = 'event';
  const selected = reportPatch();
  $('selected-evidence').textContent = selected
    ? (selected.name ?? 'Candidate footprint') + ' · ' + formatArea(selected.areaHa)
    : 'Whole event · ' + state.data.label;
  $('interpret-button').disabled = false;
  state.report = buildReport(selected);
  showReport(state.report);
}

function buildReport(patch = reportPatch()) {
  return evidenceReport({
    ...state, patch, numeric: Boolean(state.screen?.numeric), sources: details[state.id].sources,
  });
}

function toggleOutlook(show) {
  $('outlook-zones').hidden = !show;
  if (show) {
    if (state.mode === 'terrain') state.mode = events[state.id].defaultView;
    state.focus = 'scene';
    state.viewport = null;
    state.cursor = null;
  }
  updateControls();
}

function selectRiskZone(id, focus = true) {
  if (!state.outlook) return;
  const zone = describeZone(state.outlook, id);
  if (!zone || !focus) return;
  const [x, y] = zone.center;
  state.viewport = clampExtent([x - 45, y - 45, 90, 90], state.data.grid);
  state.cursor = null;
  draw();
}

async function prepareOutlook(id, grid, turn) {
  if (id !== 'rondonia') {
    showOutlook(null, 'A projection needs compatible repeat observations across multiple years and independently confirmed disturbance history.');
    return;
  }
  showOutlook(null, 'Loading the Rondônia tree-cover-loss outlook…');
  try {
    const outlook = await loadOutlook(grid);
    if (turn !== state.load) return;
    state.outlook = outlook;
    showOutlook(outlook, outlook.targetYear + ' tree-cover-loss outlook · source history through ' + outlook.cutoff);
    if (!state.report?.model && !activeInterpretation) resetReport();
  } catch {
    if (turn === state.load) showOutlook(null, 'The outlook is unavailable. Observed change and the evidence report are still available.');
  }
}

async function requestInterpretation() {
  const selection = state.selection;
  const controller = new AbortController();
  activeInterpretation = controller;
  $('interpret-button').disabled = true;
  $('interpret-status').textContent = 'Generating an evidence report…';
  try {
    const response = await fetch('/api/interpret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: state.id, scope: $('report-scope').value, patchId: reportPatch()?.id ?? null,
        dropDb: state.dropDb, minimumHa: state.minimumHa }),
      signal: controller.signal,
    });
    const answer = await response.json();
    if (selection !== state.selection) return;
    if (!response.ok) throw new Error(answer.error || 'The interpretation could not be loaded.');
    state.report = applyAI(buildReport(), answer);
    showReport(state.report);
    $('interpret-status').textContent = 'AI-assisted report. Review the source measurements before acting.';
  } catch (error) {
    if (selection === state.selection) $('interpret-status').textContent = error.message + ' You can still download the evidence checklist.';
  } finally {
    if (selection === state.selection) $('interpret-button').disabled = false;
    if (activeInterpretation === controller) activeInterpretation = null;
  }
}


function selectPatch(id) {
  state.patchId = id;
  state.viewport = null;
  state.cursor = null;
  $('pixel-inspection').textContent = 'Move over a map to inspect the same cell across dates.';
  document.querySelectorAll('[data-patch]').forEach(button => button.setAttribute('aria-pressed', Number(button.dataset.patch) === id));
  $('patch-select').value = id == null ? '' : String(id);
  const patch = activePatch();
  const isBrazil = state.id === 'rondonia';
  rows('patch-metrics', !patch ? [] : isBrazil ? [
    ['Footprint area', formatArea(patch.areaHa)],
    ['Mean VH change', formatDb(patch.meanDb)],
    ...(patch.id === 1 ? [['Nearby stable forest', formatDb(state.data.patches[1].meanDb)]] : []),
    ['VH change on 11 Sept 2022', formatDb(patch.repeatDb)],
    ['Mapped tree-cover loss overlap', patch.referencePct + '%'],
  ] : [
    ['Flagged area', formatArea(patch.areaHa)],
    ['Median HV change', formatDb(patch.hvDb, !state.screen?.numeric)],
    ...(patch.hhDb == null ? [] : [['Median HH change', formatDb(patch.hhDb, !state.screen?.numeric)]]),
  ]);
  $('patch-detail').textContent = !patch ? '' : isBrazil
    ? (patch.id === 1 ? 'The same footprint is outlined in all three panels. Radar and optical acquisition dates differ.' : 'Nearby forest observed on the same dates provides a local comparison.')
    : 'Radar decrease in historical tree cover. The cause remains unverified.';
  updateControls();
  resetReport();
}

function populatePatches() {
  const { patches } = state.result;
  $('patch-label').hidden = !patches.length;
  $('patch-select').replaceChildren(...patches.map((patch, index) => new Option(
    (patch.name ?? 'Candidate ' + (index + 1)) + ' · ' + formatArea(patch.areaHa), patch.id,
  )));
  $('patch-list').replaceChildren(...patches.map((patch, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.patch = patch.id;
    button.textContent = (patch.name ?? 'Candidate ' + (index + 1)) + ' · ' + formatArea(patch.areaHa);
    button.addEventListener('click', () => { state.focus = 'patch'; selectPatch(patch.id); });
    return button;
  }));
  selectPatch(patches.some(patch => patch.id === state.patchId) ? state.patchId : patches[0]?.id ?? null);
}

function rebuildScreen() {
  state.dropDb = Number($('drop-db').value);
  state.minimumHa = Number($('minimum-ha').value);
  state.result = screenForest(state.screen, state.dropDb, state.minimumHa);
  const { patches, flaggedHa, forestHa } = state.result;
  $('screen-summary').textContent = patches.length + (patches.length === 1 ? ' candidate' : ' candidates')
    + ' · ' + formatArea(flaggedHa) + ' flagged across ' + formatArea(forestHa) + ' screened';
  populatePatches();
}

function updateControls() {
  const patch = activePatch();
  if (!patch) state.focus = 'scene';
  document.querySelectorAll('[data-band]').forEach(button => button.setAttribute('aria-pressed', button.dataset.band === state.band));
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.mode === state.mode));
  document.querySelectorAll('[data-focus]').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.focus === state.focus);
    button.disabled = button.dataset.focus === 'patch' && !patch;
  });
  const { data, band } = state;
  const layer = data.layers[band];
  rows('metrics', [
    [state.id === 'rondonia' ? 'Scene eligible radar cells' : 'Shared coverage', layer.validPct + '%'],
    ['Median change', formatDb(layer.medianDb)],
    ['Drop ≥ ' + data.thresholdDb + ' dB', layer.dropKm2.toFixed(3) + ' km²'],
    ['Rise ≥ ' + data.thresholdDb + ' dB', layer.riseKm2.toFixed(3) + ' km²'],
  ]);
  updateSummary();
  draw();
}

function pickPatch(event) {
  if (state.dragged) return;
  const [left, top, width, height] = state.extent;
  const rectangle = event.currentTarget.getBoundingClientRect();
  const x = Math.floor((event.clientX - rectangle.left) * width / rectangle.width);
  const y = Math.floor((event.clientY - rectangle.top) * height / rectangle.height);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (top + y) * state.data.grid.width + left + x;
  if ($('show-outlook').checked && event.currentTarget !== maps[0] && state.outlook?.labels[index]) {
    selectRiskZone(state.outlook.labels[index], false);
    return;
  }
  const id = state.result.labels[index];
  if (id) {
    state.focus = 'patch';
    selectPatch(id);
  }
}

async function openEvent(id) {
  const turn = ++state.load;
  state.selection++;
  activeInterpretation?.abort();
  $('comparison').hidden = true;
  $('start').hidden = false;
  $('case-status-heading').textContent = 'Loading ' + events[id].title + '…';
  $('file-status').textContent = '';
  document.querySelectorAll('[data-event]').forEach(link => {
    if (link.dataset.event === id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  try {
    if (!loaded.has(id)) loaded.set(id, loadData(id).catch(error => { loaded.delete(id); throw error; }));
    const entry = await loaded.get(id);
    if (turn !== state.load) return;
    const option = events[id];
    Object.assign(state, {
      ...entry, id, band: option.band, mode: option.defaultView, focus: 'scene', patchId: null,
      viewport: null, cursor: null, layout: 'split', dropDb: null, minimumHa: null, outlook: null, report: null,
      optical: entry.optical ?? null, referenceLayer: entry.referenceLayer ?? null, screen: entry.screen ?? null,
    });
    const { data } = entry;
    const info = details[id];
    const [before, after] = data.scenes;
    const isBrazil = id === 'rondonia';
    $('case-title').textContent = option.title;
    $('pair').textContent = (isBrazil ? 'Sentinel-1' : 'NISAR L-band') + ' · '
      + formatDate(before.date) + ' → ' + formatDate(after.date);
    $('grid').textContent = (isBrazil ? 'Relative orbit ' + before.orbit : 'Track ' + before.track + ' · frame ' + before.frame)
      + ' · ' + data.grid.spacingM + ' m grid';
    $('terrain-source').textContent = data.terrain ? 'Elevation · ' + data.terrain.source : '';
    $('terrain-button').disabled = !data.terrain;
    $('evidence-status').textContent = info.status;
    if ($('credits')) $('credits').textContent = info.credits;
    $('method-text').textContent = info.method;
    if (entry.screen?.numeric) $('method-text').textContent = 'Eight-neighbor HV decrease screening in historical tree cover and mangroves, using unclipped float32 changes from aligned linear-power inputs. Flagged area counts grid cells, not confirmed forest loss. Moisture and inundation remain alternative causes.';
    $('polarization').hidden = isBrazil;
    document.querySelector('[data-mode="optical"]').hidden = !entry.optical;
    $('screening-controls').hidden = isBrazil;
    $('show-reference').checked = false;
    $('show-boundary').checked = true;
    $('provenance').replaceChildren(
      ...[...data.scenes, ...(data.repeat ? [data.repeat] : []), ...(data.optical ?? [])].map(scene => {
        const p = document.createElement('p');
        p.textContent = scene.id;
        return p;
      }),
      ...info.sources.map(([name, url]) => {
        const a = document.createElement('a');
        a.href = url;
        a.textContent = name;
        return a;
      }),
    );
    $('report-scope').value = 'event';
    prepareOutlook(id, data.grid, turn);
    if (isBrazil) populatePatches();
    else rebuildScreen();
    $('comparison').hidden = false;
    $('start').hidden = true;
  } catch (error) {
    if (turn !== state.load) return;
    $('case-status-heading').textContent = 'Comparison unavailable';
    $('file-status').textContent = error.message;
  }
}

const currentEvent = () => {
  const id = new URL(location.href).searchParams.get('event');
  return Object.hasOwn(events, id) ? id : 'rondonia';
};
document.querySelectorAll('[data-event]').forEach(link => link.addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  if (currentEvent() !== link.dataset.event) history.pushState(null, '', link.href);
  openEvent(link.dataset.event);
}));
window.addEventListener('popstate', () => openEvent(currentEvent()));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  updateControls();
}));
document.querySelectorAll('[data-band]').forEach(button => button.addEventListener('click', () => {
  state.band = button.dataset.band;
  updateControls();
}));
document.querySelectorAll('[data-focus]').forEach(button => button.addEventListener('click', () => {
  state.focus = button.dataset.focus;
  state.viewport = null; state.cursor = null;
  updateControls();
}));
for (const id of ['rotation', 'exaggeration', 'drape', 'show-boundary', 'show-reference', 'show-change', 'swipe-position']) $(id).addEventListener('input', draw);
for (let value = 2; value <= 6; value += 0.5) $('drop-db').append(new Option(value + ' dB', value));
for (let value = 0.5; value <= 5; value += 0.5) $('minimum-ha').append(new Option(value + ' ha', value));
$('drop-db').value = DEFAULT_DROP_DB;
$('minimum-ha').value = DEFAULT_AREA_HA;
$('drop-db').addEventListener('change', rebuildScreen);
$('minimum-ha').addEventListener('change', rebuildScreen);
$('patch-select').addEventListener('change', event => { state.focus = 'patch'; selectPatch(Number(event.target.value)); });
$('interpret-button').addEventListener('click', requestInterpretation);
$('report-scope').addEventListener('change', resetReport);
$('report-download').addEventListener('click', () => downloadReport(state.report, state.id));
maps.forEach(map => map.addEventListener('click', pickPatch));
document.querySelector('.method-link')?.addEventListener('click', () => { $('method').open = true; });
function updateSummary() {
  const coverage = state.coverage[state.id === 'louisiana' ? 'HV' : state.band];
  const summary = state.summary = areaSummary(coverage.cells, state.data.grid, state.result, state.id === 'rondonia');
  rows('analysis-metrics', [
    ['Valid radar analysis area', formatArea(summary.analyzedHa)],
    [summary.exhaustive ? 'Candidate disturbance' : 'Selected mapped-loss footprint', formatArea(summary.flaggedHa)],
    ['Share of valid analysis area', numbers.format(summary.flaggedPct) + '%'],
    ...(summary.screenedForestHa == null ? [] : [['Historical forest screened', formatArea(summary.screenedForestHa)],
      ['Share of screened forest', numbers.format(summary.screenedForestPct ?? 0) + '%']]),
  ]);
  $('analysis-note').textContent = summary.exhaustive
    ? 'HV screening totals follow the threshold and minimum area below, regardless of the displayed polarization. Candidate disturbance is not confirmed deforestation.'
    : 'Selected evidence footprint only; not an exhaustive loss total. The nearby stable control is excluded. Analysis coverage counts eligible, unmasked radar cells.';
  $('quality-note').textContent = state.id === 'louisiana'
    ? (state.screen.numeric ? 'Measurements use unclipped float32 radar changes.' : 'Approximate patch measurements: display-derived change, clipped at ±8 dB; a 0.06 dB threshold margin reduces quantization ambiguity.')
    : 'Radar and optical dates differ. Optical colors are contextual, not quantitative change measurements. Shared radar coverage is checked independently.';
}

function inspectCell(point) {
  state.cursor = point;
  const [x, y] = point;
  const i = y * state.data.grid.width + x;
  const valid = state.coverage[state.band].mask[i];
  const zone = $('show-outlook').checked ? state.outlook?.labels[i] : null;
  let text = `Cell ${x + 1}, ${y + 1} · ${state.band} · `;
  if (!valid) text += 'No shared radar data; excluded from analysis.';
  else if (state.screen) {
    const delta = state.screen.numeric?.[state.band]?.[i] ?? (state.screen[state.band][i] - 127) * 8 / 127;
    text += 'after − before: ' + formatDb(delta, !state.screen.numeric);
  } else text += 'Valid radar cell. Per-cell numerical change is not available in this archive.';
  $('pixel-inspection').textContent = text + (zone ? ' · Monitoring priority zone ' + zone : '');
}

function mapPoint(event, extent = state.extent) {
  const rect = event.currentTarget.getBoundingClientRect();
  return [Math.max(0, Math.min(state.data.grid.width - 1, Math.floor(extent[0] + (event.clientX - rect.left) / rect.width * extent[2]))),
    Math.max(0, Math.min(state.data.grid.height - 1, Math.floor(extent[1] + (event.clientY - rect.top) / rect.height * extent[3])))];
}
function zoom(factor, anchor) {
  if (!state.data) return;
  state.viewport = zoomExtent(state.extent, factor, state.data.grid, anchor);
  state.cursor = null; draw();
}
function resetView() { state.viewport = null; state.cursor = null; state.focus = 'scene'; updateControls(); }
$('zoom-in').addEventListener('click', () => zoom(.7));
$('zoom-out').addEventListener('click', () => zoom(1 / .7));
$('reset-view').addEventListener('click', resetView);
document.querySelectorAll('[data-layout]').forEach(button => button.addEventListener('click', () => {
  state.layout = button.dataset.layout; draw();
}));
for (const map of maps) {
  let drag;
  map.addEventListener('wheel', event => {
    if (!state.data) return;
    event.preventDefault();
    const rect = map.getBoundingClientRect();
    zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2, [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height]);
  }, { passive: false });
  map.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    state.dragged = false;
    drag = { x: event.clientX, y: event.clientY, extent: [...state.extent], rect: map.getBoundingClientRect() };
    map.setPointerCapture(event.pointerId);
  });
  map.addEventListener('pointermove', event => {
    if (!state.data) return;
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.dragged = true;
      if (state.dragged) state.viewport = clampExtent([drag.extent[0] - dx / drag.rect.width * drag.extent[2],
        drag.extent[1] - dy / drag.rect.height * drag.extent[3], ...drag.extent.slice(2)], state.data.grid);
    }
    inspectCell(mapPoint(event, state.viewport ?? state.extent)); draw();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) map.addEventListener(name, () => { drag = null; });
  map.addEventListener('pointerleave', () => { if (!drag) { state.cursor = null; draw(); } });
  map.addEventListener('keydown', event => {
    if (!state.data) return;
    const moves = { ArrowLeft: [-.15, 0], ArrowRight: [.15, 0], ArrowUp: [0, -.15], ArrowDown: [0, .15] };
    if (moves[event.key]) {
      event.preventDefault(); const [dx, dy] = moves[event.key]; const [x, y, w, h] = state.extent;
      state.viewport = clampExtent([x + dx * w, y + dy * h, w, h], state.data.grid); state.cursor = null; draw();
    } else if (['+', '=', '-', 'Home'].includes(event.key)) {
      event.preventDefault(); if (event.key === 'Home') resetView(); else zoom(event.key === '-' ? 1.4 : 1 / 1.4);
    }
  });
}
$('export-evidence').addEventListener('click', () => {
  const evidence = { schema: 'canopy-watch-evidence/v1', eventId: state.id, scenes: state.data.scenes,
    grid: state.data.grid, displayedBand: state.band, changeConvention: 'after minus before (dB)',
    screening: state.screen ? { band: 'HV', dropDb: state.dropDb, minimumHa: state.minimumHa,
      thresholdMarginDb: state.screen.numeric ? 0 : .06, connectivity: 8 } : null,
    summary: state.summary, patch: activePatch() ?? null, limitations: [$('analysis-note').textContent, $('quality-note').textContent],
    optical: state.data.optical ?? null, reference: state.data.reference ?? null };
  const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = state.id + '-evidence.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Optional imperative handoff for the globe shell; the existing URL entry point still works.
export async function openComparison(eventId) {
  if (!Object.hasOwn(events, eventId)) throw new Error('Unknown comparison event.');
  return openEvent(eventId);
}
openEvent(currentEvent());
