// Pure comparison contracts: no DOM, network, or display-derived scientific claims.
export function validateComparison(data) {
  const fail = message => { throw new Error(message); };
  const g = data?.grid;
  if (data?.schema !== 'canopy-watch-comparison/v1' || !g
      || ![g.width, g.height].every(n => Number.isInteger(n) && n > 0)
      || g.width * g.height > 4_000_000 || !Number.isFinite(g.spacingM) || g.spacingM <= 0
      || !Number.isInteger(g.epsg) || g.epsg <= 0) fail('Invalid comparison grid or projection.');
  if (!Array.isArray(data.scenes) || data.scenes.length !== 2) fail('A comparison needs two acquisitions.');
  const [before, after] = data.scenes;
  if (![before, after].every(s => s?.id && Number.isFinite(Date.parse(s.date)))
      || Date.parse(before.date) >= Date.parse(after.date)) fail('Before must precede after.');
  const fields = before.id.startsWith('NISAR_')
    ? ['track', 'pass', 'frame', 'bandwidth', 'polarization', 'release'] : ['orbit', 'collection'];
  for (const key of fields) {
    if (before[key] == null || after[key] == null || before[key] !== after[key]) {
      fail('Incompatible acquisition pair: ' + key + ' must match.');
    }
  }
  if (!data.layers || !Object.keys(data.layers).length) fail('No shared polarization is available.');
  for (const [band, layer] of Object.entries(data.layers)) {
    if (!['before', 'after', 'change'].every(k => typeof layer[k] === 'string')
        || !Array.isArray(layer.range) || layer.range.length !== 2
        || !layer.range.every(Number.isFinite) || layer.range[0] >= layer.range[1]
        || !Number.isFinite(layer.validPct) || layer.validPct <= 0 || layer.validPct > 100) {
      fail('No usable shared coverage or display scale for ' + band + '.');
    }
  }
  if (g.bounds && (!Array.isArray(g.bounds) || g.bounds.length !== 4 || !g.bounds.every(Number.isFinite)
      || Math.abs(g.bounds[2] - g.bounds[0] - g.width * g.spacingM) > .01
      || Math.abs(g.bounds[3] - g.bounds[1] - g.height * g.spacingM) > .01)) {
    fail('Raster bounds, resolution, and dimensions do not align.');
  }
  return data;
}

export function commonMask(before, after, change) {
  if (before.length !== after.length || before.length !== change.length || before.length % 4) {
    throw new Error('The imagery grids do not match.');
  }
  const mask = new Uint8Array(before.length / 4);
  let cells = 0;
  for (let i = 0; i < mask.length; i++) {
    mask[i] = Number(before[4 * i + 3] === 255 && after[4 * i + 3] === 255 && change[4 * i + 3] === 255);
    cells += mask[i];
  }
  if (!cells) throw new Error('These acquisitions have no shared valid pixels.');
  return { mask, cells };
}

export function areaSummary(validCells, grid, result, curated = false) {
  const cellHa = grid.spacingM ** 2 / 10_000;
  // A stable control is never counted as a disturbance footprint.
  const flaggedCells = curated ? result.patches.filter(p => p.referencePct > 0)
    .reduce((sum, p) => sum + Math.round(p.areaHa / cellHa), 0)
    : result.patches.reduce((sum, p) => sum + p.cells, 0);
  return {
    validCells, analyzedHa: validCells * cellHa, flaggedHa: flaggedCells * cellHa,
    flaggedPct: validCells ? flaggedCells / validCells * 100 : null,
    screenedForestHa: curated ? null : result.forestHa,
    screenedForestPct: !curated && result.forestHa ? flaggedCells * cellHa / result.forestHa * 100 : null,
    exhaustive: !curated,
  };
}

export function clampExtent(extent, grid) {
  const width = Math.max(1, Math.min(grid.width, Math.round(extent[2])));
  const height = Math.max(1, Math.min(grid.height, Math.round(extent[3])));
  return [Math.max(0, Math.min(grid.width - width, Math.round(extent[0]))),
    Math.max(0, Math.min(grid.height - height, Math.round(extent[1]))), width, height];
}

export function zoomExtent(extent, factor, grid, anchor = [.5, .5]) {
  const width = Math.max(Math.min(16, grid.width), Math.min(grid.width, extent[2] * factor));
  const height = Math.max(Math.min(16, grid.height), Math.min(grid.height, extent[3] * factor));
  return clampExtent([extent[0] + (extent[2] - width) * anchor[0],
    extent[1] + (extent[3] - height) * anchor[1], width, height], grid);
}
