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
    const comparison = await load(manifest.comparisonPath);
    notice.textContent = 'Provisional radar evidence · observed precipitation · soil moisture unavailable';
    const limitations = node('details', null, root); limitations.open = true;
    node('summary', 'Evidence status and limits', limitations);
    const list = node('ul', null, limitations); manifest.limitations.forEach(text => node('li', text, list));
    const [radar, rain] = manifest.layers;
    const radarSection = node('section', null, root);
    node('h2', 'Radar backscatter · dB', radarSection);
    node('p', radar.source + ' · ' + radar.resolution, radarSection);
    const label = node('label', 'Polarization ', radarSection);
    const select = node('select', null, label); select.setAttribute('aria-label', 'Radar polarization');
    Object.keys(comparison.layers).forEach(band => { const option = node('option', band, select); option.value = band; });
    select.value = comparison.layers.HV ? 'HV' : Object.keys(comparison.layers)[0];
    const legend = node('p', '', radarSection);
    const panels = node('div', null, radarSection); panels.className = 'drought-panels';
    const images = ['before', 'after'].map((side, index) => {
      const figure = node('figure', null, panels);
      node('figcaption', side + ' · ' + comparison.scenes[index].date.slice(0, 10), figure);
      const viewport = node('div', null, figure); viewport.className = 'radar-viewport';
      const image = node('img', null, viewport); image.alt = side + ' gamma0 radar backscatter';
      image.draggable = false; return { image, viewport };
    });
    let scale = 1;
    const tools = node('div', null, radarSection); tools.className = 'drought-tools';
    for (const [text, factor] of [['Zoom in', 1.5], ['Zoom out', 1 / 1.5], ['Reset zoom', 0]]) {
      const button = node('button', text, tools); button.type = 'button';
      button.onclick = () => { scale = factor ? Math.max(1, Math.min(8, scale * factor)) : 1;
        images.forEach(({ image }) => { image.style.width = scale * 100 + '%'; }); };
    }
    let syncing = false;
    images.forEach(({ viewport }, index) => viewport.addEventListener('scroll', () => {
      if (syncing) return; syncing = true;
      const other = images[1-index].viewport; other.scrollLeft = viewport.scrollLeft; other.scrollTop = viewport.scrollTop;
      requestAnimationFrame(() => { syncing = false; });
    }));
    function update() {
      const layer = comparison.layers[select.value];
      images[0].image.src = layer.before; images[1].image.src = layer.after;
      legend.textContent = select.value + ' gamma0 · common grayscale: ' + layer.range.join(' to ') + ' dB. Enlarging this archive adds no detail.';
    }
    select.onchange = update; update();
    const section = node('section', null, root);
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
    const download = node('a', 'Download evidence manifest', root); download.href = event.manifestPath; download.download = event.id + '.json';
  } catch (error) { notice.textContent = error.message + '. Return to the globe or reload to retry.'; }
}
