import { applyAI, downloadReport, mountReport, showReport } from '../comparison/report.js';

const probability = number => Math.round(number * 100) + '%';
const signed = number => (number > 0 ? '+' : '') + number.toFixed(1);

function drawRainfallRange(canvas, outlook) {
  const range = outlook.rainfallRange;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(2, 2);
  const x = [36, 143, 248];
  const y = total => 106 - 83 * total / Math.max(range.highMm, outlook.thresholdMm, 1);
  const observed = range.observed.map(row => y(row.cumulativeMm));
  const threshold = y(outlook.thresholdMm);
  const median = y(range.medianMm);

  context.fillStyle = '#ece3ca';
  context.beginPath();
  context.moveTo(x[1], observed[1]);
  context.lineTo(x[2], y(range.highMm));
  context.lineTo(x[2], y(range.lowMm));
  context.closePath();
  context.fill();

  context.strokeStyle = '#82601e';
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(9, threshold);
  context.lineTo(274, threshold);
  context.stroke();
  context.strokeStyle = '#255e45';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x[1], observed[1]);
  context.lineTo(x[2], median);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(x[0], observed[0]);
  context.lineTo(x[1], observed[1]);
  context.stroke();

  context.font = '12px system-ui';
  context.fillStyle = '#274138';
  context.textAlign = 'center';
  [...range.observed.map(row => row.month), outlook.target].forEach((month, i) => {
    const [year, number] = month.split('-').map(Number);
    const label = new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
    context.fillText(label, x[i], 128);
    context.beginPath();
    context.arc(x[i], [...observed, median][i], 3, 0, Math.PI * 2);
    context.fill();
  });
}

export function renderRainfallOutlook(parent, outlook) {
  const panel = document.createElement('section');
  panel.className = 'data-panel outlook-panel';
  panel.innerHTML = `<div class="outlook-head"><h2>Rainfall outlook</h2></div>
    <p class="drought-probability"></p><p class="drought-outlook-window"></p>
    <p class="drought-outlook-threshold"></p><figure class="drought-outlook-chart" hidden>
    <canvas width="560" height="280" aria-hidden="true"></canvas><figcaption></figcaption></figure>
    <details><summary>Backtest and method</summary>
    <p class="drought-backtest"></p><p class="drought-method"></p><a class="drought-outlook-source">NOAA rainfall history</a></details>`;
  parent.append(panel);
  if (!outlook) {
    panel.querySelector('.drought-probability').textContent = 'Outlook unavailable';
    panel.querySelector('details').hidden = true;
    return;
  }
  panel.querySelector('.drought-probability').textContent = probability(outlook.probability) + ' estimated chance of a dry 3-month total';
  panel.querySelector('.drought-outlook-window').textContent = 'Climate division ' + outlook.division + ' · three months ending '
    + outlook.target + ' · observations available through ' + outlook.through;
  panel.querySelector('.drought-outlook-threshold').textContent = 'Dry threshold: below ' + outlook.thresholdMm
    + ' mm for the three-month period (historical 20th percentile). '
    + 'The first two months already total ' + outlook.priorTwoMonthsMm + ' mm.';
  const chart = panel.querySelector('figure');
  const range = outlook.rainfallRange;
  chart.hidden = false;
  chart.querySelector('figcaption').textContent = 'Cumulative rainfall. The solid line shows observed totals. The dashed line extends to the seasonal median of '
    + range.medianMm + ' mm, with a middle 80% range of ' + range.lowMm + '–' + range.highMm
    + ' mm. The dotted horizontal line marks the dry threshold.';
  drawRainfallRange(chart.querySelector('canvas'), outlook);
  panel.querySelector('.drought-backtest').textContent = 'Selected: ' + outlook.modelLabel + '. Held-out '
    + outlook.backtest.years.join('–') + ' Brier scores over ' + outlook.backtest.months + ' months: '
    + 'logistic ' + outlook.backtest.logisticBrier.toFixed(3) + ', seasonal baseline '
    + outlook.backtest.baselineBrier.toFixed(3) + '. Lower is better.';
  panel.querySelector('.drought-method').textContent = 'Given the two observed months, the seasonal baseline estimates how often '
    + 'rainfall in the remaining month would take the total below the historical threshold. It uses the prior 30 years for '
    + 'that calendar month. Validation selects the method and the later backtest evaluates both methods. '
    + 'This experimental outlook covers regional precipitation. Drought severity, soil moisture, and conditions at individual sites require separate evidence.';
  panel.querySelector('.drought-outlook-source').href = outlook.source.url;
}

function evidenceReport(event, manifest, radar, rain, scenes, outlook) {
  const preview = radar.presentation === 'official-browse';
  const record = manifest.independentRecord;
  const dryMonths = rain.series.filter(row => row.anomalyMm < 0);
  return {
    label: event.name,
    scope: 'Whole event',
    sections: [
      [
        'NISAR collected the two radar scenes on ' + radar.dates.join(' and ') + '.',
        'NOAA division-scale precipitation anomalies were ' + rain.series.map(row => row.month + ': ' + signed(row.anomalyMm) + ' mm').join(', ') + '.',
        dryMonths.length + ' of ' + rain.series.length + ' context months recorded rainfall below their seasonal normal.',
      ],
      [
        record.scope,
        preview ? 'The two radar previews use separate display scales. Soil moisture, vegetation and surface conditions can also affect backscatter.'
          : 'Radar backscatter responds to moisture, inundation, vegetation and roughness. Regional rainfall provides context for those changes.',
      ],
      [
        'Compare the regional rainfall signal with a local gauge, streamflow or an independent soil-moisture product.',
        'Check a later matched NISAR pass and the latest drought assessment to see if the signal persists.',
      ],
      [
        'Prioritize follow-up observations where the drought assessment and local measurements agree.',
        outlook ? 'Revisit the experimental regional rainfall outlook when the next complete monthly observation is available.'
          : 'Use the latest official regional outlook for planning follow-up observations.',
      ],
    ],
    evidence: [
      ...manifest.limitations,
      'NOAA baseline: ' + rain.baseline + '.',
      ...(outlook ? [outlook.target + ' regional rainfall outlook: ' + probability(outlook.probability)
        + ' chance of a three-month total below ' + outlook.thresholdMm + ' mm given data through ' + outlook.through + '.'] : []),
    ],
    provenance: scenes,
    links: [
      ['NOAA precipitation data', rain.sourceUrl], [record.label, record.url],
      ...(outlook ? [['NOAA outlook training history', outlook.source.url]] : []),
    ],
  };
}

export function renderDroughtReport(parent, event, manifest, radar, rain, scenes, outlook) {
  const panel = document.createElement('section');
  panel.className = 'data-panel interpretation';
  panel.innerHTML = `<div class="interpret-head"><div><h2 id="interpreter-title"></h2>
    <p id="selected-evidence">Whole event</p></div>
    <button class="primary" type="button" id="interpret-button"></button></div>
    <p id="interpret-status" role="status"></p><div id="interpret-result" hidden></div>`;
  parent.append(panel);
  mountReport({ allowPatch: false });
  const fallback = evidenceReport(event, manifest, radar, rain, scenes, outlook);
  let report = fallback;
  showReport(report);
  panel.querySelector('#report-download').onclick = () => downloadReport(report, event.id);
  const button = panel.querySelector('#interpret-button');
  const status = panel.querySelector('#interpret-status');
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Generating an evidence report…';
    try {
      const response = await fetch('/api/interpret', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event.id, scope: 'event' }),
      });
      const answer = await response.json();
      if (!response.ok) throw Error(answer.error || 'The AI report could not be generated.');
      report = applyAI(fallback, answer);
      showReport(report);
      status.textContent = 'AI report generated from event evidence.';
    } catch (error) {
      status.textContent = error.message + ' The evidence report is still available to download.';
    } finally {
      button.disabled = false;
    }
  };
}
