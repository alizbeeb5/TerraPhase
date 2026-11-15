function drawReplay(canvas, samples) {
  const ctx = canvas.getContext('2d');
  const top = 9, left = 28, width = 224, height = 98;
  const levels = samples.flatMap(row => [row.observedFt, row.predictedFt, row.persistenceFt]).filter(Number.isFinite);
  const maximum = Math.ceil(Math.max(1, ...levels) / 10) * 10;
  const minimum = Math.min(0, ...levels);
  const x = index => left + width * index / (samples.length - 1);
  const y = value => top + height - height * (value - minimum) / (maximum - minimum);
  ctx.scale(2, 2);
  ctx.font = '10px system-ui';
  ctx.fillStyle = '#40584c';
  ctx.strokeStyle = '#d7e1db';
  for (const level of [0, maximum / 2, maximum]) {
    ctx.beginPath();
    ctx.moveTo(left, y(level));
    ctx.lineTo(left + width, y(level));
    ctx.stroke();
    ctx.fillText(level + ' ft', 1, y(level) + 3);
  }
  ctx.fillText('00:00', left, 124);
  ctx.fillText('09:00', left + width / 2 - 12, 124);
  ctx.fillText('18:00', left + width - 26, 124);
  for (const [key, color, dash] of [
    ['observedFt', '#245e47', []], ['predictedFt', '#a35b0b', [5, 4]], ['persistenceFt', '#4e5b85', [2, 4]],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let open = false;
    samples.forEach((sample, index) => {
      if (!Number.isFinite(sample[key])) { open = false; return; }
      if (open) ctx.lineTo(x(index), y(sample[key]));
      else ctx.moveTo(x(index), y(sample[key]));
      open = true;
    });
    ctx.stroke();
  }
}

export function mountHazardOutlook(previous, outlook, replay) {
  const panel = document.createElement('section');
  panel.className = 'data-panel outlook-panel hazard-outlook';
  panel.innerHTML = '<h2></h2><p></p><p></p>';
  panel.querySelector('h2').textContent = outlook.kind === 'model' ? 'River stage outlook' : 'Monitoring outlook';
  const [summary, condition] = panel.querySelectorAll('p');
  summary.textContent = outlook.kind === 'model' && !replay ? 'The historical river-stage replay is unavailable.' : outlook.summary;
  condition.textContent = outlook.condition;
  previous.after(panel);
  if (!replay) return;
  const figure = document.createElement('figure');
  figure.className = 'hazard-replay';
  const canvas = document.createElement('canvas');
  canvas.width = 520;
  canvas.height = 266;
  canvas.setAttribute('aria-hidden', 'true');
  drawReplay(canvas, replay.replay);
  const caption = document.createElement('figcaption');
  const stages = key => replay.replay.map(sample => sample[key]).filter(Number.isFinite);
  const observed = Math.max(...stages('observedFt'));
  const predicted = Math.max(...stages('predictedFt'));
  caption.textContent = 'July 4, 2025 (CDT). Solid green is observed, dashed amber is the one-hour model, and dotted blue is the no-change baseline. '
    + 'Observed peak in view: ' + observed + ' ft. Replay peak: ' + predicted + ' ft. Gaps indicate missing inputs or readings.';
  figure.append(canvas, caption);
  summary.after(figure);
  const details = document.createElement('details');
  const test = replay.heldOut;
  const development = replay.validation;
  const note = document.createElement('p');
  note.textContent = replay.model + ' · one-hour horizon. For windows with at least 0.15 ft of stage change in the prior 30 minutes, '
    + 'validation (' + development.years.join('–') + ') mean absolute errors (MAE) were ' + development.trainedChangingMaeFt
    + ' ft for the model and ' + development.persistenceChangingMaeFt + ' ft for persistence. On '
    + test.years[0] + ' held-out changing windows (' + test.changingSamples + '), trained-model MAE was '
    + test.trainedChangingMaeFt + ' ft and persistence MAE was ' + test.persistenceChangingMaeFt
    + ' ft. The model saw stages up to ' + replay.trainingPeakFt + ' ft in training and can miss abrupt peaks.';
  const heading = document.createElement('summary');
  heading.textContent = 'Training and backtest';
  const link = document.createElement('a');
  link.href = replay.stationUrl;
  link.textContent = 'USGS Kerrville gauge';
  details.append(heading, note, link);
  panel.append(details);
}
