import { DEFAULT_AREA_HA, DEFAULT_DROP_DB, decodeScreening, screenForest } from './screening.js';

const $ = id => document.getElementById(id);
const events = {
  rondonia: { path: '/rondonia/comparison.json', band: 'VH', title: 'Rondônia, Brazil', defaultView: 'optical' },
  louisiana: { path: '/canopy-watch-louisiana.json', band: 'HV', title: 'Louisiana, USA', defaultView: 'radar' },
};
const maps = ['before-map', 'after-map', 'change-map'].map($);
const canvas = $('overlay');
const context = canvas.getContext('2d');
const dates = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const numbers = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const formatDate = value => dates.format(new Date(value));
const formatArea = value => numbers.format(value) + ' ha';
const formatDb = (value, approximate = false) => (approximate ? '≈ ' : '') + value.toFixed(2) + ' dB';
const state = { load: 0, selection: 0 };
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
  const data = await readJson(events[id].path);
  const { grid } = data;
  if (data.schema !== 'canopy-watch-comparison/v1' || !grid?.width || !grid.height || data.scenes?.length !== 2) {
    throw Error('The comparison metadata is invalid.');
  }
  const images = Object.fromEntries(await Promise.all(Object.entries(data.layers).map(async ([band, layer]) => [
    band, Object.fromEntries(await Promise.all(['before', 'after', 'change'].map(async view => [view, await image(layer[view], grid)]))),
  ])));
  if (id === 'louisiana') {
    const screen = decodeScreening(await readJson('/louisiana-screening.json'));
    if (JSON.stringify(screen.grid) !== JSON.stringify(grid)) throw Error('The radar and forest screening grids differ.');
    return { data, images, screen };
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
  return { data, images, optical: { before, after }, referenceLayer, result: { patches: data.patches, labels } };
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
  $('terrain-viewport').hidden = !terrain;
  $('terrain-controls').hidden = !terrain;
  $('view-options').hidden = terrain;
  $('reference-option').hidden = !state.referenceLayer;
  const isDelta = !terrain || drape === 'change';
  const range = isDelta ? [-8, 8] : data.layers[band].range;
  $('scale-min').textContent = range[0] + ' dB';
  $('scale-max').textContent = (range[1] > 0 ? '+' : '') + range[1] + ' dB';
  $('ramp').classList.toggle('delta', isDelta);
  $('backscatter-scale').textContent = mode === 'radar'
    ? 'Before and after share the ' + data.layers[band].range.join(' to ') + ' dB scale.' : '';
  $('key-caption').textContent = isDelta ? 'Cyan decrease · Orange increase'
    + (!terrain && $('show-boundary').checked && activePatch() ? ' · Gold footprint' : '')
    + (!terrain && state.id === 'rondonia' && state.focus === 'scene' ? ' · Dark gaps are masked radar cells' : '')
    + (!terrain && state.referenceLayer && $('show-reference').checked ? ' · Purple mapped loss' : '') : 'Backscatter';
  if (terrain) {
    drawTerrain(images[band][drape], data.terrain, data.grid);
    return;
  }
  const sources = mode === 'optical' ? state.optical : images[band];
  const observations = mode === 'optical' ? data.optical : data.scenes;
  const sensor = mode === 'optical' ? 'Sentinel-2' : band;
  $('before-date').textContent = sensor + ' · ' + formatDate(observations[0].date);
  $('after-date').textContent = sensor + ' · ' + formatDate(observations[1].date);
  $('difference-date').textContent = band + ' · ' + formatDate(data.scenes[0].date) + ' → ' + formatDate(data.scenes[1].date);
  const extent = state.extent = crop();
  const [, , width, height] = extent;
  $('map-scale').textContent = numbers.format(width * data.grid.spacingM / 1000) + ' km across each panel';
  const layers = [sources.before, sources.after, images[band].change];
  maps.forEach((map, index) => {
    map.width = width;
    map.height = height;
    const ctx = map.getContext('2d');
    ctx.drawImage(layers[index], ...extent, 0, 0, width, height);
    if (index === 2 && state.referenceLayer && $('show-reference').checked) {
      ctx.globalAlpha = .55;
      ctx.drawImage(state.referenceLayer, ...extent, 0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    drawBoundaries(ctx, extent, index === 2);
    map.setAttribute('aria-label', ['Before · ' + $('before-date').textContent,
      'After · ' + $('after-date').textContent, 'Radar difference · ' + band][index]);
    map.classList.toggle('pickable', index === 2 && state.focus === 'scene' && Boolean(state.result?.patches.length));
  });
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

function drawInterpretation(answer) {
  const sections = [
    ['What changed', answer.observation],
    ['Canopy disturbance explanation', answer.explanation],
    ['Other possible causes', answer.alternatives],
    ['How to verify', answer.verification],
  ];
  const output = $('interpret-result');
  output.replaceChildren(...sections.map(([title, values]) => {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading);
    const items = Array.isArray(values);
    const body = document.createElement(items ? 'ul' : 'p');
    if (items) {
      for (const value of values) {
        const item = document.createElement('li');
        item.textContent = value;
        body.append(item);
      }
    } else {
      body.textContent = values;
    }
    section.append(body);
    return section;
  }));
  output.hidden = false;
}

async function requestInterpretation() {
  const selection = state.selection;
  const controller = new AbortController();
  activeInterpretation = controller;
  $('interpret-button').disabled = true;
  $('interpret-status').textContent = 'Interpreting the selected patch…';
  $('interpret-result').hidden = true;
  try {
    const response = await fetch('/api/interpret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: state.id, patchId: state.patchId, dropDb: state.dropDb, minimumHa: state.minimumHa }),
      signal: controller.signal,
    });
    const answer = await response.json();
    if (selection !== state.selection) return;
    if (!response.ok) throw new Error(answer.error || 'The interpretation could not be loaded.');
    drawInterpretation(answer);
    $('interpret-status').textContent = 'AI interpretation';
  } catch (error) {
    if (selection === state.selection) $('interpret-status').textContent = error.message;
  } finally {
    if (selection === state.selection) $('interpret-button').disabled = false;
    if (activeInterpretation === controller) activeInterpretation = null;
  }
}


function selectPatch(id) {
  state.patchId = id;
  $('patch-select').value = id == null ? '' : String(id);
  const patch = activePatch();
  const isBrazil = state.id === 'rondonia';
  $('selected-evidence').textContent = patch
    ? (patch.name ?? 'Candidate footprint') + ' · ' + formatArea(patch.areaHa)
    : 'No candidate footprint at these settings.';
  $('interpret-button').disabled = !patch;
  state.selection++;
  activeInterpretation?.abort();
  $('interpret-status').textContent = '';
  $('interpret-result').hidden = true;
  rows('patch-metrics', !patch ? [] : isBrazil ? [
    ['Footprint area', formatArea(patch.areaHa)],
    ['Mean VH change', formatDb(patch.meanDb)],
    ...(patch.id === 1 ? [['Nearby stable forest', formatDb(state.data.patches[1].meanDb)]] : []),
    ['VH change on 11 Sept 2022', formatDb(patch.repeatDb)],
    ['Mapped tree-cover loss overlap', patch.referencePct + '%'],
  ] : [
    ['Flagged area', formatArea(patch.areaHa)],
    ['Median HV change', formatDb(patch.hvDb, true)],
    ...(patch.hhDb == null ? [] : [['Median HH change', formatDb(patch.hhDb, true)]]),
  ]);
  $('patch-detail').textContent = !patch ? '' : isBrazil
    ? (patch.id === 1 ? 'The same footprint is outlined in all three panels. Radar and optical acquisition dates differ.' : 'Nearby forest observed on the same dates provides a local comparison.')
    : 'Radar decrease in historical tree cover. The cause remains unverified.';
  updateControls();
}

function populatePatches() {
  const { patches } = state.result;
  $('patch-label').hidden = !patches.length;
  $('patch-select').replaceChildren(...patches.map((patch, index) => new Option(
    (patch.name ?? 'Candidate ' + (index + 1)) + ' · ' + formatArea(patch.areaHa), patch.id,
  )));
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
  draw();
}

function pickPatch(event) {
  if (state.focus !== 'scene') return;
  const [left, top, width, height] = state.extent;
  const rectangle = event.currentTarget.getBoundingClientRect();
  const x = Math.floor((event.clientX - rectangle.left) * width / rectangle.width);
  const y = Math.floor((event.clientY - rectangle.top) * height / rectangle.height);
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const id = state.result.labels[(top + y) * state.data.grid.width + left + x];
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
      ...entry, id, band: option.band, mode: option.defaultView, focus: 'patch', patchId: null,
      optical: entry.optical ?? null, referenceLayer: entry.referenceLayer ?? null,
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
    $('credits').textContent = info.credits;
    $('method-text').textContent = info.method;
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
  updateControls();
}));
for (const id of ['rotation', 'exaggeration', 'drape', 'show-boundary', 'show-reference']) $(id).addEventListener('input', draw);
for (let value = 2; value <= 6; value += 0.5) $('drop-db').append(new Option(value + ' dB', value));
for (let value = 0.5; value <= 5; value += 0.5) $('minimum-ha').append(new Option(value + ' ha', value));
$('drop-db').value = DEFAULT_DROP_DB;
$('minimum-ha').value = DEFAULT_AREA_HA;
$('drop-db').addEventListener('change', rebuildScreen);
$('minimum-ha').addEventListener('change', rebuildScreen);
$('patch-select').addEventListener('change', event => selectPatch(Number(event.target.value)));
$('interpret-button').addEventListener('click', requestInterpretation);
$('change-map').addEventListener('click', pickPatch);
document.querySelector('.method-link').addEventListener('click', () => { $('method').open = true; });
openEvent(currentEvent());
