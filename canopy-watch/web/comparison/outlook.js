const $ = id => document.getElementById(id);
const pct = value => (value * 100).toFixed(1) + '%';

export function mountOutlook(onToggle, onZone) {
  const card = document.createElement('section');
  card.className = 'data-panel outlook-panel';
  card.setAttribute('aria-labelledby', 'outlook-title');
  card.innerHTML = `<div class="outlook-head"><h2 id="outlook-title">Where to monitor next</h2>
    <label id="outlook-switch" hidden><input id="show-outlook" type="checkbox"> Outlook map</label></div>
    <p id="outlook-status"></p>
    <div id="outlook-available" hidden>
      <p id="outlook-summary"></p>
      <div id="outlook-zones" hidden><label for="outlook-zone">Inspect a priority zone</label>
        <select id="outlook-zone"><option value="">Choose a zone</option></select><p id="outlook-zone-detail" role="status"></p></div>
      <details><summary>Backtest and data source</summary><p id="outlook-method"></p>
        <table><thead><tr><th scope="col">Year</th><th scope="col">Mapped loss cells</th><th scope="col" id="outlook-model-column"></th>
          <th scope="col" id="outlook-alt-column"></th></tr></thead><tbody id="outlook-years"></tbody></table>
        <p id="outlook-local" hidden></p>
        <p><a id="outlook-source"></a></p></details>
    </div>`;
  document.querySelector('.interpretation').before(card);
  $('show-outlook').addEventListener('change', event => onToggle(event.target.checked));
  $('outlook-zone').addEventListener('change', event => onZone(Number(event.target.value)));
}

export async function loadOutlook(eventId, grid) {
  const assetRoot = '/' + encodeURIComponent(eventId) + '/';
  const response = await fetch(assetRoot + 'outlook.json');
  if (!response.ok) throw Error('The risk outlook could not load.');
  const data = await response.json();
  if (data.schema !== 'canopy-watch-outlook/v1' || data.eventId !== eventId
      || ['width', 'height', 'epsg', 'spacingM'].some(key => data.grid?.[key] !== grid[key])
      || (grid.bounds && grid.bounds.some((value, i) => value !== data.bounds?.[i]))
      || data.zoneRaster !== assetRoot + 'outlook-zones.png'
      || !Array.isArray(data.zones) || !data.zones.length) throw Error('Risk zones do not match this map grid.');
  const image = new Image();
  image.src = data.zoneRaster;
  await image.decode();
  if (image.naturalWidth !== grid.width || image.naturalHeight !== grid.height) throw Error('Risk raster has the wrong size.');
  const layer = document.createElement('canvas');
  layer.width = grid.width;
  layer.height = grid.height;
  const ctx = layer.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const rgba = ctx.getImageData(0, 0, grid.width, grid.height);
  const labels = Uint16Array.from({ length: grid.width * grid.height }, (_, i) => rgba.data[i * 4] + rgba.data[i * 4 + 1] * 256);
  const { width, height } = grid;
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i];
    const x = i % width;
    const y = Math.floor(i / width);
    const edge = id && (!x || !y || x === width - 1 || y === height - 1 || labels[i - 1] !== id
      || labels[i + 1] !== id || labels[i - width] !== id || labels[i + width] !== id);
    rgba.data.set(edge && (x + y) % 7 < 4 ? [255, 142, 250, 255] : [180, 29, 175, id ? 112 : 0], i * 4);
  }
  ctx.putImageData(rgba, 0, 0);
  return { ...data, labels, layer };
}

export function showOutlook(outlook, message) {
  $('outlook-status').textContent = message;
  $('outlook-switch').hidden = !outlook;
  $('outlook-available').hidden = !outlook;
  $('show-outlook').checked = false;
  $('outlook-zones').hidden = true;
  $('outlook-zone-detail').textContent = '';
  if (!outlook) return;
  const rank = (outlook.rankedForestShare * 100).toLocaleString('en');
  const louisiana = outlook.eventId === 'louisiana';
  $('outlook-summary').textContent = 'Dashed magenta zones mark the highest-ranked ' + rank
    + '% of eligible forest cells for follow-up imagery.'
    + (louisiana ? ' This outlook uses annual Landsat-derived tree-cover loss. NISAR footprints show separate radar changes.' : '');
  const evalData = outlook.evaluation;
  const isModel = outlook.model === 'Logistic ranking';
  $('outlook-model-column').textContent = isModel ? 'Selected model' : 'Proximity baseline';
  $('outlook-alt-column').textContent = isModel ? 'Proximity baseline' : 'Logistic model';
  const localLoss = evalData.localHeldOut?.reduce((total, row) => total + row.lossCells, 0);
  const localResult = localLoss
    ? ' In the displayed footprint, the same top-share ranking captured ' + pct(evalData.localCapture)
      + ' of ' + localLoss.toLocaleString('en') + ' mapped loss cells.'
    : louisiana ? ' The displayed footprint had no mapped loss in the test years, so the backtest applies to the surrounding study area.' : '';
  $('outlook-method').textContent = outlook.model + ' captured ' + pct(evalData.selectedCapture)
    + ' of later mapped loss in the highest-ranked ' + rank + '% of eligible cells in held-out 2023–2025 spatial blocks.'
    + localResult + ' The outlook assumes historical patterns continue. The eligible mask starts with at least 30% canopy cover in 2000 '
    + 'and excludes mapped loss through the cutoff. It does not capture regrowth. '
    + 'The 30 m ranks are drawn on the ' + outlook.grid.spacingM + ' m viewer grid. Scores describe monitoring priority.';
  const local = $('outlook-local');
  local.hidden = !evalData.localHeldOut;
  if (evalData.localHeldOut) {
    const field = isModel ? 'modelHits' : 'proximityHits';
    local.textContent = 'Displayed footprint by year (captured / mapped cells): ' + evalData.localHeldOut
      .map(row => row.year + ' · ' + (row.lossCells ? row[field] + '/' + row.lossCells : 'no mapped loss'))
      .join('; ') + '.';
  }
  $('outlook-years').replaceChildren(...evalData.heldOut.map(row => {
    const tr = document.createElement('tr');
    const values = [row.year, row.lossCells,
      row.lossCells ? pct((isModel ? row.modelHits : row.proximityHits) / row.lossCells) : '—',
      row.lossCells ? pct((isModel ? row.proximityHits : row.modelHits) / row.lossCells) : '—'];
    for (const value of values) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    return tr;
  }));
  $('outlook-source').textContent = outlook.source.name + ' · ' + outlook.source.license;
  $('outlook-source').href = outlook.source.url;
  $('outlook-zone').replaceChildren(new Option('Choose a zone', ''),
    ...outlook.zones.map(zone => new Option('Zone ' + zone.id, zone.id)));
}

export function describeZone(outlook, id) {
  const zone = outlook.zones.find(zone => zone.id === id);
  if (!zone) { $('outlook-zone-detail').textContent = ''; return null; }
  $('outlook-zone').value = String(id);
  $('outlook-zone-detail').textContent = 'Zone ' + id + ' · Median distance to mapped loss from the last three years: '
    + zone.medianRecentLossDistanceM + ' m. Inputs: ' + outlook.drivers.join(', ') + '.';
  return zone;
}
