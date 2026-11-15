const assetRoot = new URL('../data/nisar/', import.meta.url);
const $ = id => document.getElementById(id);
const region = $('region');
const acquisition = $('scene');
const comparison = $('compare');
const layerButtons = [...document.querySelectorAll('[data-layer]')];
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});
const layerLabels = {HH: 'HH backscatter', HV: 'HV backscatter', map: 'Map overview'};
let scenes = [];
let layer = 'map';
let generation = 0;

function date(scene) {
  return dateFormat.format(new Date(scene.acquired));
}

function selectRegion(preferredId) {
  const available = scenes.filter(scene => scene.location === region.value);
  acquisition.replaceChildren(...available.map(scene => new Option(date(scene), scene.id)));
  acquisition.value = available.some(scene => scene.id === preferredId) ? preferredId : available.at(-1).id;
  acquisition.disabled = available.length < 2;
  comparison.disabled = available.length < 2;
  if (comparison.disabled) comparison.checked = false;
}

function showImage(prefix, scene) {
  const image = $(prefix + '-image');
  const asset = scene.assets[layer];
  image.alt = scene.location + ', ' + date(scene) + ', ' + layerLabels[layer];
  $(prefix + '-caption').textContent = date(scene) + ' · ' + layerLabels[layer];
  const src = new URL(asset.image, assetRoot).href;
  if (image.src !== src) image.src = src;
  return image.decode();
}

function sourceLink(title, url) {
  const anchor = document.createElement('a');
  anchor.textContent = title;
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  return anchor;
}

function update() {
  const current = scenes.find(scene => scene.id === acquisition.value);
  const available = scenes.filter(scene => scene.location === current.location);
  const compare = comparison.checked && available.length === 2;
  const visible = compare ? available : [current];
  const version = ++generation;
  $('scene-title').textContent = current.location;
  $('other-view').hidden = !compare;
  $('browse-images').classList.toggle('comparing', compare);
  acquisition.disabled = compare || available.length < 2;
  layerButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layer === layer)));

  const label = document.createElement('strong');
  label.textContent = compare ? 'Panama repeat-pass pair' : date(current);
  const description = document.createElement('p');
  description.textContent = compare
    ? 'Both acquisitions use track 040, descending, frame 084. View imagery side by side.'
    : 'NISAR L-band Level 2 GCOV, Frequency A. Granule ID ' + current.cmr + '.';
  $('scene-detail').replaceChildren(label, description);
  const links = visible.flatMap(scene => [
    sourceLink(date(scene) + ' · Original ' + layer + ' PNG', scene.assets[layer].browse),
    sourceLink(date(scene) + ' · Science HDF5 (Earthdata sign-in)', scene.science),
  ]);
  $('scene-downloads').replaceChildren(...links);

  $('image-status').textContent = 'Loading imagery…';
  Promise.all(visible.map((scene, index) => showImage(index ? 'other' : 'current', scene))).then(() => {
    if (version === generation) $('image-status').textContent = compare
      ? 'Each browse image has its own display stretch. Compare scene features visually.'
      : 'Rendered browse image from the Alaska Satellite Facility.';
  }).catch(() => {
    if (version === generation) $('image-status').textContent = 'A preview failed to load. Open its original PNG from the scene links.';
  });

  const url = new URL(location.href);
  url.searchParams.set('scene', current.cmr);
  url.searchParams.set('layer', layer);
  if (compare) url.searchParams.set('compare', '1');
  else url.searchParams.delete('compare');
  history.replaceState(null, '', url);
}

async function load() {
  const response = await fetch(new URL('scenes.json', assetRoot));
  if (!response.ok) throw new Error('Scene list unavailable');
  scenes = await response.json();
  const params = new URLSearchParams(location.search);
  const initial = scenes.find(scene => scene.cmr === params.get('scene')) ?? scenes[1];
  const requestedLayer = params.get('layer');
  if (Object.hasOwn(layerLabels, requestedLayer)) layer = requestedLayer;
  region.replaceChildren(...[...new Set(scenes.map(scene => scene.location))].map(name => new Option(name, name)));
  region.value = initial.location;
  region.disabled = false;
  selectRegion(initial.id);
  comparison.checked = !comparison.disabled && params.get('compare') === '1';
  region.addEventListener('change', () => { selectRegion(); update(); });
  acquisition.addEventListener('change', update);
  comparison.addEventListener('change', update);
  layerButtons.forEach(button => button.addEventListener('click', () => {
    layer = button.dataset.layer;
    update();
  }));
  update();
}

load().catch(() => {
  $('image-status').textContent = 'The scene list failed to load. Open the original imagery in Google Drive.';
});
