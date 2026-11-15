import { mapPosition } from '../comparison/map-outlook.js';

const markerLetter = index => String.fromCharCode(65 + index);
const replayTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export function drawMapMarkers(ctx, outlook, grid, extent, readout) {
  const [left, top, width, height] = extent;
  const radius = Math.max(3, Math.min(width, height) / 34);
  ctx.save();
  ctx.font = 'bold ' + Math.round(radius * 1.05) + 'px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  outlook.markers.forEach((marker, index) => {
    let [x, y] = mapPosition(grid.bounds, grid.width, grid.height, marker.coordinates);
    x -= left;
    y -= top;
    if (x < 0 || y < 0 || x > width || y > height) return;
    ctx.fillStyle = '#6b3f0e';
    ctx.strokeStyle = '#fff7e7';
    ctx.lineWidth = Math.max(1, radius / 5);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(markerLetter(index), x, y);
    if (index === 0 && readout) {
      const labelWidth = ctx.measureText(readout).width + radius;
      const start = x + 1.3 * radius + labelWidth < width ? x + 1.3 * radius : x - 1.3 * radius - labelWidth;
      ctx.fillStyle = '#fff7e7';
      ctx.fillRect(start, y - radius * .8, labelWidth, radius * 1.6);
      ctx.fillStyle = '#472b0c';
      ctx.fillText(readout, start + labelWidth / 2, y);
    }

    if (!Number.isFinite(marker.heading)) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((marker.heading - 90) * Math.PI / 180);
    ctx.strokeStyle = '#ffce77';
    ctx.lineWidth = radius / 3;
    ctx.setLineDash([radius / 2, radius / 3]);
    ctx.beginPath();
    ctx.moveTo(radius * 1.4, 0);
    ctx.lineTo(radius * 4.6, 0);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(radius * 3.9, -radius * .65);
    ctx.lineTo(radius * 4.7, 0);
    ctx.lineTo(radius * 3.9, radius * .65);
    ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
}

export function mountMapLegend(parent, outlook, replay, onTimeChange) {
  const panel = document.createElement('section');
  panel.className = 'hazard-outlook-map data-panel';
  panel.hidden = true;
  const header = document.createElement('h2');
  header.textContent = outlook.label;
  panel.append(header);
  const note = document.createElement('p');
  note.textContent = outlook.note;
  panel.append(note);

  const markers = document.createElement('ul');
  outlook.markers.forEach((marker, index) => {
    const item = document.createElement('li');
    item.textContent = markerLetter(index) + ' · ' + marker.name + ' · ' + marker.detail;
    markers.append(item);
  });
  panel.append(markers);
  let readout = '';
  if (replay) {
    const label = document.createElement('label');
    label.textContent = 'Replay time · 4 July 2025';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.step = '1';
    slider.max = String(replay.replay.length - 1);
    // Start at observed peak to show how the model handled the event's rapid rise.
    slider.value = replay.replay.reduce((best, row, index, series) =>
      (row.observedFt ?? -Infinity) > (series[best].observedFt ?? -Infinity) ? index : best, 0);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const value = stage => Number.isFinite(stage) ? stage.toFixed(2) + ' ft' : 'unavailable';
    function update() {
      const row = replay.replay[Number(slider.value)];
      const time = replayTime.format(new Date(row.utc));
      slider.setAttribute('aria-valuetext', time);
      readout = Number.isFinite(row.predictedFt) ? value(row.predictedFt) : 'No estimate';
      status.textContent = time + ' · A: One-hour prediction ' + value(row.predictedFt)
        + ' · observed ' + value(row.observedFt) + ' · persistence ' + value(row.persistenceFt);
    }
    slider.oninput = () => { update(); onTimeChange(); };
    label.append(slider);
    panel.append(label, status);
    update();
  }
  const sources = document.createElement('div');
  sources.className = 'hazard-outlook-map-sources';
  for (const [label, url] of outlook.sources) {
    const source = document.createElement('a');
    source.href = url;
    source.textContent = label;
    sources.append(source);
  }
  panel.append(sources);
  parent.after(panel);
  return { panel, readout: () => readout };
}
