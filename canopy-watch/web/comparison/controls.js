// Mount inside the existing comparison shell; index.html belongs to the globe teammate.
export function mountControls({ includeFootprints = true } = {}) {
  const toolbar = document.createElement('div');
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'comparison-back'; back.textContent = '← Back to globe';
  back.hidden = !document.getElementById('event-comparison-root');
  back.addEventListener('click', () => document.dispatchEvent(new CustomEvent('comparison:back')));
  document.querySelector('#comparison .stage-head').prepend(back);
  toolbar.className = 'comparison-toolbar';
  toolbar.innerHTML = `<div class="segmented" aria-label="Comparison layout">
    <button type="button" data-layout="split" aria-pressed="true">Before / After</button>
    <button type="button" data-layout="change">Change map</button>
    <button type="button" data-layout="swipe">Swipe</button>
  </div><div class="comparison-navigation" aria-label="Shared map navigation">
    <button type="button" id="zoom-in" aria-label="Zoom all maps in">+</button>
    <button type="button" id="zoom-out" aria-label="Zoom all maps out">−</button>
    <button type="button" id="reset-view">Fit study area</button>
  </div><label><input type="checkbox" id="show-change"> Change overlay</label>
  <label id="swipe-control" hidden>Before / after split <input type="range" id="swipe-position" min="0" max="100" value="50"></label>
  <p>Drag to pan · scroll to zoom · arrow keys to move · same location in every panel</p>`;
  document.getElementById('plate').before(toolbar);
  const caption = document.createElement('p');
  caption.id = 'change-context'; caption.className = 'pixel-inspection'; caption.hidden = true;
  document.getElementById('plate').before(caption);
  const inspection = document.createElement('p');
  inspection.id = 'pixel-inspection';
  inspection.className = 'pixel-inspection';
  inspection.textContent = 'Move over a map to inspect the same cell across dates.';
  document.getElementById('plate').after(inspection);
  const summary = document.createElement('section');
  summary.className = 'comparison-summary data-panel';
  summary.innerHTML = `<h2>Analysis coverage</h2><dl id="analysis-metrics" class="metrics"></dl>
    <p id="analysis-note"></p><p id="quality-note"></p>
    <button type="button" id="export-evidence">Download evidence JSON</button>`;
  document.querySelector('#comparison .evidence-head').after(summary);
  if (includeFootprints) {
    const list = document.createElement('div');
    list.id = 'patch-list';
    list.className = 'comparison-patch-list';
    list.setAttribute('aria-label', 'Footprints: select to focus every map');
    document.getElementById('patch-detail').after(list);
  }
  for (const map of document.querySelectorAll('.map-panel canvas')) {
    map.tabIndex = 0;
    map.setAttribute('aria-description', 'Drag or use arrow keys to pan all panels. Plus and minus zoom. Home fits the study area.');
  }
}
