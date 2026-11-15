const sectionNames = ['What changed', 'What could explain it', 'What to verify', 'Recommended response'];

export function mountReport() {
  const button = document.getElementById('interpret-button');
  button.textContent = 'Generate AI report';
  document.getElementById('interpreter-title').textContent = 'Evidence report';
  const controls = document.createElement('div');
  controls.className = 'report-controls';
  controls.innerHTML = `<label for="report-scope">Report scope</label>
    <select id="report-scope"><option value="event">Whole event</option><option value="patch">Selected footprint</option></select>
    <button type="button" id="report-download">Download report</button>`;
  document.querySelector('.interpret-head').after(controls);
  const source = document.createElement('details');
  source.id = 'report-sources';
  document.getElementById('interpret-result').after(source);
}

export function evidenceReport({ id, patch, result, data, band, dropDb, minimumHa, outlook, numeric, summary, sources }) {
  const brazil = id === 'rondonia';
  const scope = patch?.name ?? (patch ? 'Candidate footprint ' + patch.id : 'Whole event');
  const dates = data.scenes.map(scene => scene.date.slice(0, 10));
  const sensors = brazil ? 'Sentinel-1 VH' : 'NISAR HV';
  const reference = brazil ? 'Hansen Global Forest Change v1.12 annual loss map' : 'ESA WorldCover 2021 tree cover and mangroves';
  const observations = [];
  if (brazil) {
    const focus = patch ?? data.patches[0];
    observations.push(sensors + ' (' + dates.join(' → ') + ') measured a mean change of ' + focus.meanDb.toFixed(2)
      + ' dB over the ' + focus.areaHa.toFixed(2) + ' ha ' + focus.name.toLowerCase() + '.',
    'Mapped tree-cover loss overlaps ' + focus.referencePct + '% of this footprint. The repeat radar on '
      + data.repeat.date + ' measured ' + focus.repeatDb.toFixed(2) + ' dB relative to the first scene.');
    if (!patch) observations.push('The nearby stable control measured ' + data.patches[1].meanDb.toFixed(2) + ' dB.');
  } else if (patch) {
    observations.push(sensors + ' (' + dates.join(' → ') + ') flagged ' + patch.areaHa.toFixed(2) + ' ha in this footprint.'
      + ' Its median HV change was ' + (numeric ? '' : 'approximately ') + patch.hvDb.toFixed(2) + ' dB.');
  } else {
    observations.push(sensors + ' (' + dates.join(' → ') + ') flagged ' + result.patches.length + ' candidate footprints covering '
      + result.flaggedHa.toFixed(2) + ' ha of ' + result.forestHa.toFixed(2) + ' ha of eligible historical forest.',
    'Screening used a ' + dropDb + ' dB minimum HV drop and a ' + minimumHa + ' ha minimum patch.');
  }

  const stable = brazil && patch?.id === 2;
  const noCandidate = !brazil && !patch && !result.patches.length;
  let alternatives, verification, actions;
  if (stable) {
    alternatives = ['The small change is consistent with local variability in the stable control.'];
    verification = ['Compare the control with the loss footprint on the same radar dates and the repeat pass.'];
    actions = ['Keep this area as a reference in the next review and check for sustained departures from its baseline.'];
  } else if (brazil) {
    alternatives = ['Repeat radar, optical imagery and the annual loss map support canopy disturbance in the mapped footprint. Clearing, harvest, and fire are possible drivers.'];
    verification = ['Compare optical imagery from ' + data.optical.map(scene => scene.date).join(' and ') + ' within the observed boundary.',
      'Check a newer cloud-free image and local records to verify the land-use change and cause.'];
    actions = ['Save the footprint and source dates for the relevant land manager to review.',
      'If review confirms ongoing clearing, ask the manager to assess access controls and monitoring at the advancing boundary.',
      outlook ? 'Prioritize follow-up imagery in the dashed risk zones and update the review as new observations arrive.'
        : 'Prioritize follow-up imagery around the mapped loss boundary.'];
  } else {
    alternatives = ['Moisture, inundation, and vegetation change can all affect radar backscatter. These candidates have no independent forest-loss confirmation.'];
    verification = ['Check cloud-free optical imagery near the acquisitions and compare nearby stable tree cover.',
      'Check recent rainfall, surface water, and inundation evidence, then look for a persistent signal in another matched NISAR pass.'];
    actions = [noCandidate ? 'Record the current screening settings and revisit the area after the next compatible pass.'
      : 'Prioritize optical checks for the largest candidates. Keep the observed radar footprint and dates in the evidence record.',
      'If an independent source confirms disturbance, share the evidence with the relevant land manager to determine the cause and response.'];
    if (outlook) actions.push('Use the dashed zones to plan follow-up imagery. Check the 2026 radar candidates separately.');
  }
  const links = [...sources];
  if (outlook) links.push([outlook.source.name, outlook.source.url]);
  const provenance = [...data.scenes, ...(data.repeat ? [data.repeat] : []), ...(data.optical ?? [])];
  return {
    label: data.label, scope, links, provenance,
    sections: [observations, alternatives, verification, actions],
    evidence: [
      'Radar display: ' + band + '. Base reference: ' + reference + '.',
      'Analysis coverage: ' + summary.analyzedHa.toFixed(2) + ' ha of valid radar cells.',
      brazil ? 'The curated patch statistics are separate from the study-wide coverage.'
        : numeric ? 'Patch changes use the unclipped numerical raster.' : 'Patch changes are approximate and use display-derived values clipped at ±8 dB.',
      outlook ? 'Modeled outlook: ' + outlook.targetYear + ', history through ' + outlook.cutoff
        + ', ' + outlook.model + '. Priority zones rank eligible forest cells.'
        : 'A projection needs compatible multi-year observations and an independent disturbance history.',
      ...(!brazil && outlook ? ['The outlook uses Landsat-derived loss history. Its zones do not verify the 2026 NISAR candidates.'] : []),
      ...(patch?.box ? ['Footprint extent in comparison grid pixels [left, top, right, bottom]: ' + patch.box.join(', ') + '.'] : []),
      ...(patch?.centerM ? ['Footprint center (EPSG:' + data.grid.epsg + '): ' + patch.centerM.join(', ') + ' m.'] : []),
    ],
  };
}

export function applyAI(report, answer) {
  return {
    ...report, model: answer.model,
    sections: [report.sections[0], [answer.observation, answer.explanation, ...answer.alternatives], answer.verification, answer.actions],
  };
}

export function showReport(report) {
  const output = document.getElementById('interpret-result');
  output.replaceChildren(...report.sections.map((items, i) => {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = sectionNames[i];
    const list = document.createElement(i >= 2 ? 'ol' : 'ul');
    list.replaceChildren(...items.map(text => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
    section.append(heading, list);
    return section;
  }));
  output.hidden = false;
  const sources = document.getElementById('report-sources');
  const summary = document.createElement('summary');
  summary.textContent = 'Measurements and sources';
  const evidence = report.evidence.map(text => {
    const p = document.createElement('p');
    p.textContent = text;
    return p;
  });
  const acquisitions = report.provenance.map(scene => {
    const p = document.createElement('p');
    p.className = 'report-acquisition';
    p.textContent = scene.date.slice(0, 10) + ' · ' + scene.id;
    return p;
  });
  const links = report.links.map(([name, url]) => {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = name;
    return a;
  });
  sources.replaceChildren(summary, ...evidence, ...acquisitions, ...links);
}

export function downloadReport(report, eventId) {
  const content = [
    '# ' + report.label + ' — evidence report', '', 'Scope: ' + report.scope,
    'Prepared using: ' + (report.model ? 'AI-assistance (' + report.model + ')' : 'Canopy Watch evidence checklist'),
    'Comparison: ' + new URL('/?event=' + encodeURIComponent(eventId), location.origin), '',
    ...report.sections.flatMap((items, i) => ['## ' + sectionNames[i], '', ...items.map((item, n) =>
      (i >= 2 ? (n + 1) + '. ' : '- ') + item), '']),
    '## Measurements and sources', '', ...report.evidence.map(line => '- ' + line),
    ...report.provenance.map(scene => '- ' + scene.date.slice(0, 10) + ' · ' + scene.id),
    ...report.links.map(([name, url]) => '- [' + name + '](' + url + ')'), '',
  ].join('\n');
  const blob = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = blob;
  link.download = eventId + '-evidence-report.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}
