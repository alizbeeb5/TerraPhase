import { clampExtent, zoomExtent } from '../comparison/core.js';
import { mountControls } from '../comparison/controls.js';
import { mountComparisonShell } from '../comparison/workspace.js';
import { mountEventReport } from '../comparison/report.js';
import { drawTerrain } from '../comparison/terrain.js';
import { mountHazardOutlook } from './outlook.js';

const $ = id => document.getElementById(id);
const dates = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const prettyDate = date => dates.format(new Date(date));
const layouts = ['before', 'after', 'change'];

async function readJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw Error('Could not load ' + path);
  return response.json();
}

async function loadImage(path, grid) {
  const image = new Image();
  image.src = path;
  await image.decode();
  if (image.width !== grid.width || image.height !== grid.height) throw Error('Radar layers do not share a grid.');
  return image;
}

function setMetrics(id, values) {
  $(id).replaceChildren(...values.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    return [term, description];
  }));
}

function setupShell(event, data) {
  mountComparisonShell();
  mountControls({ includeFootprints: false });
  $('comparison').classList.add('hazard-workspace');
  $('comparison').querySelector('.stage-head h2').textContent = event.name;
  $('pair').textContent = data.sensor + ' · ' + data.scenes[0].orbit + ' track ' + data.scenes[0].track;
  document.querySelector('[data-mode=optical]').hidden = true;
  document.querySelector('.evidence-head h2').textContent = 'Event evidence';
  document.querySelector('.screening').hidden = true;
  $('polarization').hidden = true;
  $('view-options').querySelector('.segmented').hidden = true;
  $('show-boundary').closest('label').hidden = true;
  $('reference-option').hidden = !data.reference;
  if (data.reference) {
    $('reference-option').lastChild.textContent = ' ' + data.reference.label;
    const drape = new Option(data.reference.label, 'reference');
    $('drape').append(drape);
  }
  $('selected-evidence').textContent = 'Whole study area';
  $('exaggeration').value = 3;
  $('terrain-source').textContent = 'Elevation · ' + data.terrainSource;
  $('method-text').textContent = 'The passes share a repeat track and a common map grid. Linear power is averaged to the display grid before conversion to dB. ' + data.limits;
}

function makeReport(event, data, before, after, replay) {
  return {
    label: event.name, scope: 'Whole event',
    sections: [
      [data.sensor + ' compared ' + before.date + ' and ' + after.date + '. Median difference was '
        + after.change.medianDb + ' dB across ' + after.change.coveragePct + '% shared map coverage.', data.record.finding],
      [data.limits],
      data.verification,
      [data.outlook.summary, data.outlook.condition],
    ],
    evidence: [
      'Change is after minus before. Display range is ' + data.changeRange.join(' to ') + ' dB.',
      'Elevation source: ' + data.terrainSource + '.',
      ...(data.reference ? [data.reference.label + ' · ' + data.reference.dates.join(' → ') + '. ' + data.reference.legend] : []),
      ...(replay ? [replay.model + ' · ' + replay.horizonMinutes + '-minute historical replay at ' + replay.location + '.'] : []),
    ],
    provenance: [...before.sources, ...after.sources],
    links: [[data.record.label, data.record.url],
      ...before.sources.map(source => ['Sentinel-1 scene · ' + source.date, source.source]),
      ...after.sources.map(source => ['Sentinel-1 scene · ' + source.date, source.source]),
      ...(replay ? [['USGS station ' + replay.station, replay.stationUrl]] : [])],
  };
}

export async function mountHazard(event) {
  const data = await readJson(event.manifestPath);
  if (data.schema !== 'terraphase-hazard/v1' || data.id !== event.id || data.scenes.length < 2) {
    throw Error('Invalid event comparison.');
  }
  const { grid, scenes } = data;
  const before = scenes[0];
  const after = scenes.at(-1);
  const [terrain, base, reference, replay, lastRadar, lastChange] = await Promise.all([
    readJson(data.terrainPath), loadImage(before.path, grid),
    data.reference && loadImage(data.reference.path, grid),
    event.capabilities.forecast && readJson(event.manifestPath.replace('comparison.json', 'outlook.json')).catch(() => null),
    loadImage(after.path, grid), loadImage(after.changePath, grid),
  ]);
  setupShell(event, data);
  const setReport = mountEventReport(event.id);
  const terrainCanvas = $('overlay');
  const mapCanvases = layouts.map(layout => $(layout + '-map'));
  const full = [0, 0, grid.width, grid.height];
  const state = {
    layout: 'split', mode: 'radar', extent: full, after, images: { before: base, after: lastRadar, change: lastChange },
  };
  const dim = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
  const temporary = document.createElement('canvas');
  temporary.width = grid.width;
  temporary.height = grid.height;

  function referenceView() {
    const context = temporary.getContext('2d');
    context.clearRect(0, 0, grid.width, grid.height);
    context.drawImage(state.images.after, 0, 0);
    context.drawImage(reference, 0, 0);
    return temporary;
  }

  function draw() {
    const isTerrain = state.mode === 'terrain';
    const isSwipe = state.layout === 'swipe';
    const showReference = reference && $('show-reference').checked;
    const drape = $('drape').value;
    const deltaKey = 'Cyan decrease · Orange increase';
    const key = isTerrain && drape === 'reference' ? data.reference.legend
      : isTerrain && drape !== 'change' ? 'Shared grayscale · gamma⁰ backscatter'
      : showReference ? deltaKey + ' · ' + data.reference.legend : deltaKey;
    const scale = isTerrain && drape === 'reference' ? [] : !isTerrain || drape === 'change' ? data.changeRange : data.radarRange;
    const plate = $('plate');
    plate.hidden = isTerrain;
    plate.dataset.layout = state.layout;
    $('terrain-viewport').hidden = $('terrain-controls').hidden = !isTerrain;
    $('pixel-inspection').hidden = isTerrain;
    $('view-options').hidden = isTerrain;
    $('change-context').hidden = isTerrain || state.layout !== 'change';
    $('swipe-control').hidden = !isSwipe;
    document.querySelector('.comparison-toolbar').hidden = isTerrain;
    document.querySelectorAll('button[data-layout], button[data-mode]').forEach(button =>
      button.setAttribute('aria-pressed', String((button.dataset.layout ?? button.dataset.mode)
        === (button.dataset.layout ? state.layout : state.mode))));
    $('scale-min').textContent = scale.length ? scale[0] + ' dB' : '';
    $('scale-max').textContent = scale.length ? '+' + scale[1] + ' dB' : '';
    $('ramp').hidden = !scale.length;
    $('ramp').classList.toggle('delta', !isTerrain || drape === 'change');
    $('key-caption').textContent = key;
    $('backscatter-scale').textContent = !isTerrain ? 'Before and after share ' + data.radarRange.join(' to ') + ' dB.' : '';
    if (isTerrain) {
      terrainCanvas.setAttribute('aria-label', (drape === 'reference' ? data.reference.label : drape) + ' draped on elevation');
      drawTerrain(terrainCanvas, drape === 'reference' ? referenceView() : state.images[drape],
        terrain, grid, Number($('rotation').value), Number($('exaggeration').value));
      return;
    }
    const leftDate = prettyDate(before.date);
    const rightDate = prettyDate(state.after.date);
    $('before-date').textContent = isSwipe ? leftDate + ' → ' + rightDate : leftDate;
    $('after-date').textContent = rightDate;
    $('difference-date').textContent = leftDate + ' → ' + rightDate;
    $('change-context').textContent = 'After − before in dB over shared radar coverage. ' + data.limits;
    const extent = state.extent;
    const [, , width, height] = extent;
    $('map-scale').textContent = dim.format(grid.widthM * width / grid.width / 1000) + ' km across';
    const swipe = $('swipe-position');
    swipe.setAttribute('aria-valuetext', swipe.value + '% before');
    for (const [index, map] of mapCanvases.entries()) {
      const layer = layouts[index];
      map.setAttribute('aria-label', index === 0 && isSwipe ? 'Before left / after right. ' + leftDate + ' → ' + rightDate
        : layer === 'before' ? 'Before · ' + leftDate : layer === 'after' ? 'After · ' + rightDate : 'Radar change · ' + leftDate + ' → ' + rightDate);
      if ((isSwipe && index !== 0) || (state.layout === 'change' && index < 2)) continue;
      map.width = width;
      map.height = height;
      const ctx = map.getContext('2d');
      const paint = image => ctx.drawImage(image, ...extent, 0, 0, width, height);
      paint(state.images[layer]);
      if (index === 0 && isSwipe) {
        const cut = width * Number(swipe.value) / 100;
        ctx.clearRect(cut, 0, width - cut, height);
        ctx.save();
        ctx.beginPath();
        ctx.rect(cut, 0, width - cut, height);
        ctx.clip();
        paint(state.images.after);
        if (showReference) paint(reference);
        ctx.restore();
        if (cut > 0 && cut < width) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(cut, 0, Math.max(1, width / 300), height);
        }
      }
      if (index < 2 && $('show-change').checked) {
        ctx.globalAlpha = .48;
        paint(state.images.change);
        ctx.globalAlpha = 1;
      }
      if (index !== 0 && showReference) paint(reference);
    }
  }

  function zoom(factor, anchor) {
    state.extent = zoomExtent(state.extent, factor, grid, anchor);
    draw();
  }

  function pan(x, y) {
    const [left, top, width, height] = state.extent;
    state.extent = clampExtent([left + x, top + y, width, height], grid);
    draw();
  }

  for (const map of mapCanvases) {
    let drag = null;
    map.addEventListener('wheel', event => {
      event.preventDefault();
      const bounds = map.getBoundingClientRect();
      zoom(event.deltaY < 0 ? .8 : 1.25, [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height]);
    }, { passive: false });
    map.onpointerdown = event => {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, extent: state.extent };
      map.setPointerCapture(event.pointerId);
    };
    map.onpointermove = event => {
      const bounds = map.getBoundingClientRect();
      if (drag?.id === event.pointerId) {
        const [left, top, width, height] = drag.extent;
        state.extent = clampExtent([left - (event.clientX - drag.x) * width / bounds.width,
          top - (event.clientY - drag.y) * height / bounds.height, width, height], grid);
        draw();
      }
      const [left, top, width, height] = state.extent;
      const [west, south, east, north] = grid.bounds;
      const lon = west + (left + (event.clientX - bounds.left) / bounds.width * width) / grid.width * (east - west);
      const lat = north - (top + (event.clientY - bounds.top) / bounds.height * height) / grid.height * (north - south);
      $('pixel-inspection').textContent = lat.toFixed(4) + '°, ' + lon.toFixed(4) + '° · shared position on every map';
    };
    map.onlostpointercapture = () => { drag = null; };
    map.onkeydown = event => {
      const arrows = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
      if (Object.hasOwn(arrows, event.key)) pan(...arrows[event.key]);
      else if (event.key === '+' || event.key === '=') zoom(.8);
      else if (event.key === '-') zoom(1.25);
      else if (event.key === 'Home') { state.extent = full; draw(); }
      else return;
      event.preventDefault();
    };
  }
  $('pixel-inspection').textContent = 'Move over a map to read its geographic coordinates.';
  for (const button of document.querySelectorAll('button[data-layout], button[data-mode]')) {
    button.onclick = () => {
      if (button.dataset.layout) state.layout = button.dataset.layout;
      else state.mode = button.dataset.mode;
      draw();
    };
  }
  $('zoom-in').onclick = () => zoom(.8);
  $('zoom-out').onclick = () => zoom(1.25);
  $('reset-view').onclick = () => { state.extent = full; draw(); };
  for (const id of ['show-reference', 'show-change', 'swipe-position', 'rotation', 'exaggeration', 'drape']) $(id).oninput = draw;
  $('export-evidence').onclick = () => {
    const path = document.createElement('a');
    path.href = event.manifestPath;
    path.download = event.id + '-evidence.json';
    path.click();
  };

  function applyScene() {
    $('analysis-note').textContent = 'Shared coverage counts valid cells in both acquisitions.';
    $('quality-note').textContent = data.limits;
    setMetrics('analysis-metrics', [['Shared map coverage', state.after.change.coveragePct + '%'],
      ['Median VV change', state.after.change.medianDb + ' dB']]);
    setMetrics('metrics', [['Before coverage', before.coveragePct + '%'], ['After coverage', state.after.coveragePct + '%']]);
    $('grid').textContent = grid.width + ' × ' + grid.height + ' display grid · ' + grid.crs;
    $('evidence-status').textContent = data.record.finding;
    const report = makeReport(event, data, before, state.after, replay);
    setReport(report, state.after.date);
    $('provenance').replaceChildren(...report.links.map(([label, url]) => {
      const link = document.createElement('a');
      link.href = url;
      link.textContent = label;
      return link;
    }));
    draw();
  }

  if (scenes.length > 2) {
    const control = document.createElement('label');
    control.className = 'hazard-timeline';
    control.textContent = 'Compare with ';
    const select = document.createElement('select');
    scenes.slice(1).forEach(scene => select.add(new Option(prettyDate(scene.date), scene.date)));
    select.value = after.date;
    control.append(select);
    $('pair').after(control);
    const status = document.createElement('span');
    status.className = 'stage-meta';
    status.setAttribute('role', 'status');
    control.after(status);
    let selection = 0;
    select.onchange = async () => {
      const picked = scenes.find(scene => scene.date === select.value);
      const request = ++selection;
      status.textContent = 'Loading radar…';
      try {
        const [radar, change] = await Promise.all([loadImage(picked.path, grid), loadImage(picked.changePath, grid)]);
        if (request !== selection) return;
        state.after = picked;
        state.images.after = radar;
        state.images.change = change;
        status.textContent = '';
        applyScene();
      } catch {
        if (request !== selection) return;
        select.value = state.after.date;
        status.textContent = 'This acquisition could not load.';
      }
    };
  }

  mountHazardOutlook(document.querySelector('.comparison-summary'), data.outlook, replay);
  $('credits').textContent = data.sensor + ' · ' + data.terrainSource;
  $('start').hidden = true;
  $('comparison').hidden = false;
  applyScene();
}
