// Self-owned markup for integration into a new globe shell.
// Legacy index.html already contains these nodes and is left untouched.
export function mountComparisonShell() {
  if (document.getElementById('comparison')) return;
  const root = document.getElementById('event-comparison-root');
  if (!root) throw new Error('Provide #event-comparison-root before loading compare.js.');
  root.innerHTML = `  <section id="start" class="stage start" aria-live="polite">
    <h2 id="case-status-heading">Loading the comparison…</h2>
    <p id="file-status"></p>
  </section>
  <div class="workspace" id="comparison" hidden>
    <section class="stage" aria-label="Comparison viewer">
      <header class="stage-head">
        <div><h2 id="case-title"></h2><p class="stage-meta" id="pair"></p></div>
        <div class="segmented" aria-label="View">
          <button type="button" data-mode="optical">Optical + change</button>
          <button type="button" data-mode="radar">Radar + change</button>
          <button type="button" data-mode="terrain" id="terrain-button">3D terrain</button>
        </div>
      </header>
      <div class="plate" id="plate">
        <figure class="map-panel">
          <figcaption><strong>Before</strong><span id="before-date"></span></figcaption>
          <canvas id="before-map" role="img"></canvas>
        </figure>
        <figure class="map-panel">
          <figcaption><strong>After</strong><span id="after-date"></span></figcaption>
          <canvas id="after-map" role="img"></canvas>
        </figure>
        <figure class="map-panel delta-panel">
          <figcaption><strong>Radar difference</strong><span id="difference-date"></span></figcaption>
          <canvas id="change-map" role="img"></canvas>
        </figure>
      </div>
      <div class="viewport" id="terrain-viewport" hidden>
        <canvas id="overlay" role="img" aria-label="Radar data draped on elevation"></canvas>
      </div>
      <div class="map-controls">
        <div class="view-options" id="view-options">
          <div class="segmented" aria-label="Map extent">
            <button type="button" data-focus="patch">Selected footprint</button>
            <button type="button" data-focus="scene">Study area</button>
          </div>
          <label><input type="checkbox" id="show-boundary" checked> Footprint</label>
          <label id="reference-option" hidden><input type="checkbox" id="show-reference"> Mapped tree-cover loss</label>
          <span class="map-scale" id="map-scale"></span>
        </div>
        <div class="terrain-controls" id="terrain-controls" hidden>
          <label>Rotation <input type="range" id="rotation" min="-180" max="180" value="-28"></label>
          <label>Vertical exaggeration <input type="range" id="exaggeration" min="1" max="30" value="8"></label>
          <label>Drape <select id="drape"><option value="change">Change</option><option value="before">Before</option><option value="after">After</option></select></label>
        </div>
        <div class="map-key">
          <div class="scale-legend"><span id="scale-min"></span><span class="ramp delta" id="ramp"></span><span id="scale-max"></span></div>
          <span id="backscatter-scale"></span><span id="key-caption"></span>
        </div>
      </div>
      <section class="data-panel interpretation" aria-labelledby="interpreter-title">
        <div class="interpret-head">
          <div><h2 id="interpreter-title">AI patch interpretation</h2><p id="selected-evidence"></p></div>
          <button type="button" class="primary" id="interpret-button" disabled>Interpret patch</button>
        </div>
        <p id="interpret-status" role="status"></p>
        <div id="interpret-result" hidden></div>
      </section>
    </section>
    <aside class="evidence" aria-label="Comparison measurements">
      <div class="evidence-head"><h2>Footprint evidence</h2><p id="evidence-status"></p></div>
      <div class="data-panel screening">
        <label id="patch-label" for="patch-select" hidden>Review footprint
          <select id="patch-select"></select>
        </label>
        <dl id="patch-metrics" class="metrics"></dl>
        <p id="patch-detail"></p>
        <div id="screening-controls">
          <div class="screen-controls">
            <label>Minimum HV drop <select id="drop-db"></select></label>
            <label>Minimum patch area <select id="minimum-ha"></select></label>
          </div>
          <p id="screen-summary" class="screen-summary" role="status"></p>
        </div>
      </div>
      <div class="data-panel">
        <h2>Scene measurements</h2>
        <div class="segmented polarization" id="polarization" aria-label="Polarization">
          <button type="button" data-band="HH">HH</button>
          <button type="button" data-band="HV">HV</button>
        </div>
        <dl class="metrics" id="metrics"></dl>
        <p id="grid"></p>
        <p id="terrain-source"></p>
      </div>
      <details id="method" class="data-panel"><summary>Scene IDs and method</summary><p id="method-text"></p><div id="provenance"></div></details>
    </aside>
  </div>
`;
}
