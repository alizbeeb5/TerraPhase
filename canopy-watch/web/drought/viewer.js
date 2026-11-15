import { renderDroughtReport, renderRainfallOutlook } from './analysis.js';
import { outlookButton } from '../comparison/map-outlook.js';
import { mountDivisionMap } from './map-outlook.js';

function node(tag, text, parent) {
  const element = document.createElement(tag); if (text != null) element.textContent = text;
  parent?.append(element); return element;
}
async function load(path) {
  const response = await fetch(path); if (!response.ok) throw Error('Evidence unavailable (' + response.status + ')');
  return response.json();
}
export async function mountDrought(root, event) {
  root.replaceChildren(); root.className = 'drought-workspace';
  node('h1', event.name, root);
  const notice = node('p', 'Loading drought evidence…', root); notice.setAttribute('role', 'status');
  try {
    const manifest = await load(event.manifestPath);
    if (manifest.schema !== 'terraphase-drought/v1' || manifest.id !== event.id) throw Error('Unexpected drought manifest');
    const radar = manifest.layers.find(layer => layer.id === 'gcov');
    const rain = manifest.layers.find(layer => layer.id === 'precipitation-anomaly');
    if (!radar || !rain) throw Error('Missing drought evidence layers');
    const browse = radar.presentation === 'official-browse';
    const [comparison, outlook, divisions] = await Promise.all([
      browse ? null : load(manifest.comparisonPath),
      load(event.manifestPath.replace(/\.json$/, '-outlook.json')).then(value =>
        value.schema === 'terraphase-rainfall-outlook/v1' && value.eventId === event.id ? value : null).catch(() => null),
      load('/drought/climate-divisions.json').catch(() => null),
    ]);
    const workspace = node('div', null, root);
    workspace.id = 'comparison';
    workspace.className = 'workspace drought-comparison';
    const stage = node('section', null, workspace);
    stage.className = 'stage';
    stage.setAttribute('aria-label', 'Drought comparison viewer');
    const evidence = node('aside', null, workspace);
    evidence.className = 'evidence';
    evidence.setAttribute('aria-label', 'Drought evidence and outlook');
    notice.textContent = browse ? 'Official NISAR scene previews · observed regional precipitation'
      : 'Provisional radar evidence · observed precipitation · soil moisture unavailable';
    const limitations = node('details', null, evidence);
    limitations.className = 'data-panel drought-limits';
    node('summary', 'Evidence status and limits', limitations);
    const list = node('ul', null, limitations);
    manifest.limitations.forEach(text => node('li', text, list));
    showRadar(stage, radar, comparison, event, outlook, divisions);
    renderDroughtReport(stage, event, manifest, radar, rain, browse ? radar.scenes : comparison.scenes, outlook);
    renderRainfallOutlook(evidence, outlook);
    const section = node('section', null, evidence);
    section.className = 'data-panel drought-rain';
    node('h2', 'Seasonal precipitation anomaly · mm', section);
    node('p', rain.source + ' · ' + rain.resolution, section);
    node('p', rain.dates.join(' to ') + ' · Baseline: ' + rain.baseline, section);
    const table = node('table', null, section); node('caption', 'Monthly precipitation context (negative anomalies indicate less rainfall than normal)', table);
    const head = node('tr', null, node('thead', null, table));
    ['Month', 'Observed (mm)', 'Seasonal normal (mm)', 'Anomaly (mm)'].forEach(text => {const cell = node('th',text,head);cell.scope='col';});
    const body = node('tbody', null, table);
    rain.series.forEach(row => { const tr = node('tr', null, body);
      [row.month, row.precipitationMm.toFixed(1), row.normalMm.toFixed(1), row.anomalyMm.toFixed(1)].forEach(text => node('td', text, tr)); });
    const link = node('a', 'NOAA source and retrieval parameters', section); link.href = rain.sourceUrl;
    const record = node('p', null, section); const recordLink = node('a', manifest.independentRecord.label, record); recordLink.href = manifest.independentRecord.url;
    node('p', manifest.independentRecord.scope, section);
    const download = node('a', 'Download evidence manifest', section); download.href = event.manifestPath; download.download = event.id + '.json';
  } catch (error) { notice.textContent = error.message + '. Return to the globe or reload to retry.'; }
}


function showRadar(root, radar, comparison, event, outlook, divisions) {
  const browse = radar.presentation === 'official-browse';
  const scenes = browse ? radar.scenes : comparison.scenes;
  const bands = Object.keys(browse ? scenes[0].bands : comparison.layers);
  const section = node('section', null, root);
  section.className = 'drought-radar';
  const heading = node('div', null, section);
  heading.className = 'stage-head drought-stage-head';
  const headingText = node('div', null, heading);
  node('h2', browse ? 'NISAR radar previews' : 'Radar backscatter · dB', headingText);
  node('p', radar.source + ' · ' + radar.resolution, headingText).className = 'stage-meta';
  if (browse) {
    const { track, frame, direction, release } = radar.geometry;
    node('p', radar.maturity + ' · ' + direction + ' track ' + track + ' · frame ' + frame + ' · ' + release, headingText).className = 'stage-meta';
  }
  const group = node('div', null, heading);
  group.className = 'segmented';
  group.setAttribute('aria-label', 'Comparison layout');
  const splitButton = node('button', 'Before / After', group);
  const swipeButton = node('button', 'Swipe', group);
  splitButton.type = swipeButton.type = 'button';
  const controls = node('div', null, section);
  controls.className = 'map-controls drought-map-controls';
  const label = node('label', 'Polarization ', controls);
  const select = node('select', null, label);
  select.setAttribute('aria-label', 'Radar polarization');
  for (const band of bands) select.append(new Option(band, band));
  select.value = bands.includes('HV') ? 'HV' : bands[0];
  const legend = node('p', '', controls);
  legend.className = 'map-key';
  const panels = node('div', null, section);
  panels.className = 'drought-panels';
  const images = scenes.map((scene, index) => {
    const side = index === 0 ? 'Before' : 'After';
    const figure = node('figure', null, panels);
    node('figcaption', side + ' · ' + scene.date.slice(0, 10), figure);
    const viewport = node('div', null, figure);
    viewport.className = 'radar-viewport';
    if (browse) viewport.classList.add('browse-viewport');
    const image = node('img', null, viewport);
    image.alt = side + (browse ? ' official GCOV radar preview' : ' gamma0 radar backscatter');
    image.draggable = false;
    const sceneLinks = browse ? node('div', null, figure) : null;
    const original = sceneLinks ? node('a', 'Official full-size preview', sceneLinks) : null;
    if (sceneLinks) {
      sceneLinks.className = 'drought-scene-links';
      const science = node('a', 'Science HDF5 (Earthdata login)', sceneLinks);
      science.href = scene.scienceUrl;
      const metadata = node('a', scene.cmrId, sceneLinks);
      metadata.href = scene.metadataUrl;
    }
    return { image, viewport, original };
  });
  let scale = 1;
  const swipe = node('div', null, section);
  swipe.className = 'drought-swipe';
  swipe.hidden = true;
  const swipeView = node('div', null, swipe);
  swipeView.className = 'drought-swipe-viewport';
  const swipeImages = scenes.map((scene, index) => {
    const image = node('img', null, swipeView);
    image.alt = (index === 0 ? 'Before' : 'After') + ' radar image · ' + scene.date.slice(0, 10);
    image.draggable = false;
    return image;
  });
  const divider = node('span', null, swipeView);
  divider.className = 'drought-swipe-divider';
  divider.setAttribute('aria-hidden', 'true');
  const swipeControl = node('label', 'Before / after split', swipe);
  swipeControl.className = 'drought-swipe-control';
  const slider = node('input', null, swipeControl);
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  const dateNote = scenes.map(scene => scene.date.slice(0, 10)).join(' → ');
  node('p', 'Before on left · After on right · ' + dateNote, swipe).className = 'stage-meta';
  const links = node('div', null, swipe);
  if (browse) {
    links.className = 'drought-scene-links';
    for (const scene of scenes) {
      node('a', 'Science HDF5 · ' + scene.date.slice(0, 10), links).href = scene.scienceUrl;
    }
  }
  function positionSwipe() {
    swipeView.style.setProperty('--swipe-position', slider.value + '%');
    slider.setAttribute('aria-valuetext', slider.value + '% before');
  }
  slider.oninput = positionSwipe;
  positionSwipe();

  const tools = node('div', null, section);
  tools.className = 'drought-tools';
  const map = outlook && divisions && mountDivisionMap(section, event, outlook, divisions);
  const mapButton = map && outlookButton(group, active => setLayout(active ? 'outlook' : 'split'));
  function setLayout(layout) {
    splitButton.setAttribute('aria-pressed', String(layout === 'split'));
    swipeButton.setAttribute('aria-pressed', String(layout === 'swipe'));
    panels.hidden = tools.hidden = layout !== 'split';
    swipe.hidden = layout !== 'swipe';
    controls.hidden = layout === 'outlook';
    if (map) {
      map.hidden = layout !== 'outlook';
      mapButton.setAttribute('aria-pressed', String(!map.hidden));
    }
  }
  splitButton.onclick = () => setLayout('split');
  swipeButton.onclick = () => setLayout('swipe');
  setLayout('split');
  for (const [text, factor] of [['Zoom in', 1.5], ['Zoom out', 1 / 1.5], ['Reset zoom', 0]]) {
    const button = node('button', text, tools);
    button.type = 'button';
    button.onclick = () => {
      scale = factor ? Math.max(1, Math.min(8, scale * factor)) : 1;
      images.forEach(({ image }) => { image.style.width = scale * 100 + '%'; });
    };
  }
  if (!browse) {
    let syncing = false;
    images.forEach(({ viewport }, index) => viewport.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const other = images[1 - index].viewport;
      other.scrollLeft = viewport.scrollLeft;
      other.scrollTop = viewport.scrollTop;
      requestAnimationFrame(() => { syncing = false; });
    }));
  }
  function update() {
    if (browse) {
      images.forEach(({ image, original }, index) => {
        const band = scenes[index].bands[select.value];
        image.src = band.path;
        original.href = band.sourceUrl;
      });
      legend.textContent = select.value + ' whole-scene preview. Each date uses its own display scaling.';
    } else {
      const layer = comparison.layers[select.value];
      images[0].image.src = layer.before;
      images[1].image.src = layer.after;
      legend.textContent = select.value + ' gamma0 · common grayscale: ' + layer.range.join(' to ') + ' dB. Enlarging this archive adds no detail.';
    }
    swipeImages.forEach((image, index) => { image.src = images[index].image.getAttribute('src'); });
    const first = browse ? scenes[0].bands[select.value] : comparison.grid;
    const second = browse ? scenes[1].bands[select.value] : comparison.grid;
    if (first && second) swipeView.style.aspectRatio = String(Math.min(first.width / first.height, second.width / second.height));
  }
  select.onchange = update;
  update();
}
