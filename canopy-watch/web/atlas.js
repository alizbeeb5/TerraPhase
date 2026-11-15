import { listEvents } from './comparison/events.js';

const $ = id => document.getElementById(id);
const params = new URL(location.href).searchParams;
const storageKey = 'canopy-watch:atlas-view';
const dates = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const statusText = { ready: 'Comparison ready', processing: 'Comparison processing', unavailable: 'Imagery unavailable' };
const statusFor = event => statusText[event.status] ?? statusText.unavailable;
const formatDate = value => value && Number.isFinite(Date.parse(value)) ? dates.format(new Date(value)) : 'Unavailable';
const searchKey = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

async function renderComparison(event) {
  $('atlas').hidden = true;
  $('event-page').hidden = false;
  document.title = event.location + ' · Canopy Watch';
  $('return-link').href = '/?selected=' + encodeURIComponent(event.id);
  try {
    // The comparison module reads the event ID from the URL when it mounts.
    await import('./compare.js');
  } catch {
    $('event-comparison-root').firstElementChild.textContent = 'The comparison could not start. Reload the page to try again.';
  }
}

async function renderAtlas(events, initialStatus) {
  const list = $('site-list');
  const search = $('site-search');
  const buttons = new Map();
  const previous = params.get('selected');
  let selected = events.find(event => event.id === previous) ?? null;
  let globe;
  let globeUnavailable = false;
  let visible = events;

  function refreshSelection() {
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === selected?.id));
    globe?.setEvents(visible, selected?.id);
    const showDetail = selected && visible.includes(selected);
    $('site-detail').hidden = !showDetail;
    if (!showDetail) return;
    const ready = selected.status === 'ready';
    $('selected-location').textContent = selected.location + ' · ' + statusFor(selected);
    $('selected-title').textContent = selected.name;
    $('selected-before').textContent = formatDate(selected.beforeDate);
    $('selected-after').textContent = formatDate(selected.afterDate);
    $('explore-link').hidden = !ready;
    if (ready) $('explore-link').href = '/?event=' + encodeURIComponent(selected.id);
    $('event-unavailable').hidden = ready;
    $('event-unavailable').textContent = selected.status === 'processing'
      ? 'The comparison for this site is still processing.' : 'Comparison imagery is unavailable for this site.';
  }

  function saveView() {
    if (!globe || !selected) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ id: selected.id, view: globe.getView() })); }
    catch { /* Selection still survives via the URL. */ }
  }

  function select(id) {
    const event = events.find(entry => entry.id === id);
    if (!event) return;
    selected = event;
    const url = new URL(location.href);
    url.searchParams.delete('event');
    url.searchParams.set('selected', event.id);
    history.replaceState(null, '', url);
    globe?.focus(event);
    refreshSelection();
    saveView();
  }

  for (const event of events) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.addEventListener('click', () => select(event.id));
    const name = document.createElement('strong');
    name.textContent = event.name;
    const metadata = document.createElement('small');
    metadata.textContent = event.location + ' · ' + statusFor(event);
    button.append(name, metadata);
    li.append(button);
    list.append(li);
    buttons.set(event.id, button);
  }

  function filter() {
    const query = searchKey(search.value.trim());
    visible = events.filter(event => searchKey(event.name + ' ' + event.location).includes(query));
    for (const [id, button] of buttons) {
      button.parentElement.hidden = !visible.some(event => event.id === id);
    }
    $('catalog-status').textContent = initialStatus || (!events.length ? 'No sites are available.' :
      !visible.length ? 'No sites match your search.' : globeUnavailable ? 'Globe unavailable. Select a site from the list.' : '');
    refreshSelection();
  }

  search.disabled = events.length === 0;
  search.addEventListener('input', filter);
  $('explore-link').addEventListener('click', saveView);
  window.addEventListener('pagehide', saveView);
  filter();
  if (!events.length) {
    $('atlas-layout').classList.add('list-only');
    return;
  }

  let restoredView;
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey));
    if (selected && stored?.id === selected.id) restoredView = stored.view;
  } catch { /* The default camera works without browser storage. */ }
  try {
    const { createGlobe } = await import('./globe/globe.js');
    globe = await createGlobe({
      canvas: $('globe-canvas'), pins: $('globe-pins'), zoomIn: $('globe-zoom-in'),
      onSelect(id) {
        select(id);
        if (matchMedia('(max-width: 790px)').matches) $('site-detail').focus();
      },
      zoomOut: $('globe-zoom-out'), reset: $('globe-reset'), restoredView,
    });
    $('globe-card').hidden = false;
    if (selected && !restoredView) globe.focus(selected);
    refreshSelection();
  } catch {
    globeUnavailable = true;
    $('atlas-layout').classList.add('list-only');
    filter();
  }
}

let events = [];
let status = '';
try {
  events = await listEvents();
} catch {
  status = 'The event catalog could not load. Reload to try again.';
}
const requestedId = params.get('event');
const requested = events.find(event => event.id === requestedId);
if (requested?.status === 'ready') await renderComparison(requested);
else {
  if (requestedId && !status) status = 'That comparison is unavailable. Choose a study site below.';
  await renderAtlas(events, status);
}
