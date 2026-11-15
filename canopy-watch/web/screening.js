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
  const { width, height, spacingM, bounds } = source.grid ?? {};
  if (![width, height].every(n => Number.isInteger(n) && n > 0) || width * height > 4_000_000
      || !Number.isFinite(spacingM) || spacingM <= 0 || !Array.isArray(bounds) || bounds.length !== 4
      || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) {
    throw Error('Invalid screening grid.');
  }
  const layers = Object.fromEntries(['cover', 'HH', 'HV'].map(key => {
    const bytes = Uint8Array.from(atob(source[key]), value => value.charCodeAt(0));
    if (bytes.length !== width * height) throw Error('The forest and radar grids do not match.');
    return [key, bytes];
  }));
  let numeric = null;
  if (source.numeric) {
    if (source.numeric.encoding !== 'float32-le-base64') throw Error('Unsupported numerical change encoding.');
    numeric = Object.fromEntries(['HH', 'HV'].map(band => {
      const bytes = Uint8Array.from(atob(source.numeric[band]), value => value.charCodeAt(0));
      if (bytes.length !== width * height * 4) throw Error('Numerical radar grid dimensions do not match.');
      const view = new DataView(bytes.buffer);
      return [band, Float32Array.from({ length: width * height }, (_, i) => view.getFloat32(i * 4, true))];
    }));
  }
  return { grid: source.grid, ...layers, numeric };
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
  const valueAt = (band, cell) => data.numeric ? data.numeric[band][cell]
    : data[band][cell] === NO_DATA ? NaN : (data[band][cell] - 127) * 8 / 127;
  const margin = data.numeric ? 0 : DISPLAY_MARGIN_DB;
  const eligible = new Uint8Array(width * height);
  let forestCells = 0;
  for (let cell = 0; cell < eligible.length; cell++) {
    const hv = valueAt('HV', cell);
    if (!FOREST.has(data.cover[cell]) || !Number.isFinite(hv)) continue;
    forestCells++;
    if (hv <= -(dropDb + margin)) eligible[cell] = 1;
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
      hv.push(valueAt('HV', current));
      if (Number.isFinite(valueAt('HH', current))) hh.push(valueAt('HH', current));
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
  return { patches, labels, forestHa: forestCells * cellHa, flaggedHa,
    flaggedForestPct: forestCells ? flaggedHa / (forestCells * cellHa) * 100 : null,
    measurement: data.numeric ? 'float32-unclipped' : 'display-derived-clipped', thresholdMarginDb: margin };
}
