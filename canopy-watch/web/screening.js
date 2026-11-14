export const DEFAULT_DROP_DB = 3;
export const DEFAULT_AREA_HA = 1;
export const DISPLAY_MARGIN_DB = 0.06;
const NO_DATA = 255;
const FOREST = new Set([10, 95]);

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const upper = Math.floor(values.length / 2);
  return (values[upper] + values[Math.floor((values.length - 1) / 2)]) / 2;
}

export function decodeScreening(source) {
  if (source.schema !== 'canopy-watch-screening/v1') throw Error('Unrecognized forest screening data.');
  const { width, height } = source.grid;
  const layers = Object.fromEntries(['cover', 'HH', 'HV'].map(key => {
    const bytes = Uint8Array.from(atob(source[key]), value => value.charCodeAt(0));
    if (bytes.length !== width * height) throw Error('The forest and radar grids do not match.');
    return [key, bytes];
  }));
  return { grid: source.grid, ...layers };
}

export function validSettings(dropDb, minimumHa) {
  return Number.isInteger(dropDb * 2) && dropDb >= 2 && dropDb <= 6
    && Number.isInteger(minimumHa * 2) && minimumHa >= 0.5 && minimumHa <= 5;
}

export function screenForest(data, dropDb = DEFAULT_DROP_DB, minimumHa = DEFAULT_AREA_HA) {
  if (!validSettings(dropDb, minimumHa)) throw Error('Enter a supported threshold and patch area.');
  const { width, height, spacingM, bounds } = data.grid;
  const [west, , , north] = bounds;
  const cellHa = spacingM ** 2 / 1e4;
  const decode = value => (value - 127) * 8 / 127;
  const eligible = new Uint8Array(width * height);
  let forestCells = 0;
  for (let cell = 0; cell < eligible.length; cell++) {
    const hv = data.HV[cell];
    if (!FOREST.has(data.cover[cell]) || hv === NO_DATA) continue;
    forestCells++;
    if (decode(hv) <= -(dropDb + DISPLAY_MARGIN_DB)) eligible[cell] = 1;
  }
  const queue = new Int32Array(eligible.length);
  const labels = new Uint32Array(eligible.length);
  const patches = [];
  for (let cell = 0; cell < eligible.length; cell++) {
    if (!eligible[cell]) continue;
    let length = 1;
    queue[0] = cell;
    eligible[cell] = 0;
    let left = width, top = height, right = 0, bottom = 0;
    let sumX = 0, sumY = 0, wetlandContacts = 0, contextContacts = 0;
    const hh = [], hv = [];
    for (let offset = 0; offset < length; offset++) {
      const current = queue[offset];
      const x = current % width, y = Math.floor(current / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      sumX += x + 0.5;
      sumY += y + 0.5;
      hv.push(decode(data.HV[current]));
      if (data.HH[current] !== NO_DATA) hh.push(decode(data.HH[current]));
      for (let row = Math.max(0, y - 1); row <= Math.min(height - 1, y + 1); row++) {
        for (let col = Math.max(0, x - 1); col <= Math.min(width - 1, x + 1); col++) {
          const neighbor = row * width + col;
          if (neighbor === current) continue;
          if (!FOREST.has(data.cover[neighbor]) && data.cover[neighbor] > 0) {
            contextContacts++;
            if (data.cover[neighbor] === 80 || data.cover[neighbor] === 90) wetlandContacts++;
          }
          if (!eligible[neighbor]) continue;
          eligible[neighbor] = 0;
          queue[length++] = neighbor;
        }
      }
    }
    if (length < Math.ceil(minimumHa / cellHa - 1e-9)) continue;
    const id = cell + 1;
    for (let index = 0; index < length; index++) labels[queue[index]] = id;
    patches.push({
      id, cells: length, areaHa: +(length * cellHa).toFixed(3),
      hvDb: +median(hv).toFixed(2), hhDb: hh.length ? +median(hh).toFixed(2) : null,
      box: [left, top, right + 1, bottom + 1],
      centerM: [Math.round(west + sumX / length * spacingM), Math.round(north - sumY / length * spacingM)],
      waterOrWetlandEdgePct: contextContacts ? Math.round(100 * wetlandContacts / contextContacts) : null,
    });
  }
  patches.sort((a, b) => b.cells - a.cells || a.id - b.id);
  const flaggedHa = patches.reduce((sum, patch) => sum + patch.cells, 0) * cellHa;
  return { patches, labels, forestHa: forestCells * cellHa, flaggedHa };
}
