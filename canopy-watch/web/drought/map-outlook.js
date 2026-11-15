import { mapPosition } from '../comparison/map-outlook.js';

function polygons(division) {
  const { type, coordinates } = division.geometry;
  return type === 'MultiPolygon' ? coordinates : [coordinates];
}

function drawBoundary(ctx, division, project) {
  ctx.beginPath();
  for (const polygon of polygons(division)) {
    for (const ring of polygon) {
      const [first, ...rest] = ring;
      ctx.moveTo(...project(first));
      for (const point of rest) ctx.lineTo(...project(point));
      ctx.closePath();
    }
  }
}

export function mountDivisionMap(parent, event, outlook, data) {
  const selected = data.divisions.find(division => division.id === outlook.division);
  if (!selected) return null;
  const wrapper = document.createElement('figure');
  wrapper.className = 'outlook-division-map';
  wrapper.hidden = true;
  const canvas = document.createElement('canvas');
  const caption = document.createElement('figcaption');
  canvas.width = 1000;
  canvas.height = 520;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'NOAA climate division ' + selected.id + ' in ' + selected.state + ' and the selected study site');
  wrapper.append(canvas, caption);
  parent.append(wrapper);

  const ctx = canvas.getContext('2d');
  const [width, height] = [canvas.width, canvas.height];
  const points = polygons(selected).flat(2);
  let west = Math.min(...points.map(point => point[0]));
  let east = Math.max(...points.map(point => point[0]));
  let south = Math.min(...points.map(point => point[1]));
  let north = Math.max(...points.map(point => point[1]));
  const lonPadding = (east - west) * .3;
  const latPadding = (north - south) * .45;
  west -= lonPadding; east += lonPadding;
  south -= latPadding; north += latPadding;
  const lonScale = Math.cos((north + south) * Math.PI / 360);
  const neededWidth = (north - south) * width / height / lonScale;
  const neededHeight = (east - west) * lonScale * height / width;
  if (neededWidth > east - west) {
    const extra = (neededWidth - (east - west)) / 2;
    west -= extra; east += extra;
  } else {
    const extra = (neededHeight - (north - south)) / 2;
    south -= extra; north += extra;
  }
  const project = point => mapPosition([west, south, east, north], width, height, point);
  ctx.fillStyle = '#dfeef4';
  ctx.fillRect(0, 0, width, height);
  for (const division of data.divisions) {
    drawBoundary(ctx, division, project);
    ctx.fillStyle = '#eef2e7';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#abbfb6';
    ctx.stroke();
  }
  drawBoundary(ctx, selected, project);
  ctx.fillStyle = '#ead0ad';
  ctx.fill('evenodd');
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#754b20';
  ctx.stroke();
  const [x, y] = project([event.center.lon, event.center.lat]);
  ctx.fillStyle = '#144c40';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();

  const strong = document.createElement('strong');
  strong.textContent = Math.round(outlook.probability * 100) + '% estimated chance of a dry three-month total';
  const note = document.createElement('p');
  note.textContent = selected.name + ', ' + selected.state + ' · NOAA climate division ' + selected.id
    + ' · three months ending ' + outlook.target + ' · observations through ' + outlook.through
    + '. The outlined region shares one estimate. The green dot marks the study site.';
  const source = document.createElement('a');
  source.href = data.source;
  source.textContent = 'NOAA division boundaries';
  caption.append(strong, note, source);
  return wrapper;
}
