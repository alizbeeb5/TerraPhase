let screening;
let comparison;
let rondonia;
const pending = new Set();
const droughtEvents = {
  'louisiana-drought': 'louisiana',
  'north-florida-drought': 'north-florida',
  'eastern-north-carolina-drought': 'eastern-north-carolina',
};
const hazardEvents = new Set(['hubbard-landslides', 'krasheninnikov-eruption', 'guadalupe-river-flood', 'la-guaira-earthquakes']);

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function interpret(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'Use POST to request interpretation.' }, 405);
  const origin = request.headers.get('Origin');
  if (origin !== url.origin) return json({ error: 'Open the comparison to request interpretation.' }, 403);
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) return json({ error: 'Sign in to Canopy Watch to use the AI interpreter.' }, 401);
  if (!env.OPENAI_API_KEY) return json({ error: 'The site’s OpenAI API key is required to run the interpreter.' }, 503);
  const body = request.body?.getReader();
  if (!body) return json({ error: 'Select a patch first.' }, 400);
  let length = 0;
  const decoder = new TextDecoder();
  let raw = '';
  try {
    while (true) {
      const { value, done } = await body.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512) {
        await body.cancel();
        return json({ error: 'The request is too large.' }, 413);
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch {
    return json({ error: 'The request could not be read.' }, 400);
  }
  let selection;
  try { selection = JSON.parse(raw); } catch { return json({ error: 'Invalid patch request.' }, 400); }
  if (pending.has(user)) return json({ error: 'An interpretation is already running.' }, 429);
  const { eventId = 'louisiana', patchId, dropDb, minimumHa, scope, comparisonDate } = selection ?? {};
  const wholeEvent = scope === 'event';
  const isReport = wholeEvent || scope === 'patch';
  const drought = typeof eventId === 'string' && Object.hasOwn(droughtEvents, eventId);
  const hazard = hazardEvents.has(eventId);
  if ((scope !== undefined && !isReport) || (wholeEvent ? patchId != null : !Number.isInteger(patchId))
      || (drought || hazard ? !wholeEvent : !['louisiana', 'rondonia'].includes(eventId))) {
    return json({ error: 'Invalid event or footprint.' }, 400);
  }
  if (eventId === 'louisiana' && !validSettings(dropDb, minimumHa)) {
    return json({ error: 'Invalid screening settings.' }, 400);
  }
  const selectedPatch = wholeEvent ? null : patchId;
  let evidence;
  if (drought) evidence = droughtEvidence(droughtEvents[eventId]);
  else if (hazard) evidence = hazardEvidence(eventId, comparisonDate);
  else if (eventId === 'rondonia') evidence = rondoniaEvidence(selectedPatch);
  else evidence = louisianaEvidence(selectedPatch, dropDb, minimumHa);
  if (!evidence) return json({ error: 'Evidence is unavailable for this selection.' }, 404);
  if (isReport && !drought && !hazard) {
    evidence.reportScope = scope;
    const path = '/' + eventId + '/outlook.json';
    const outlook = Object.hasOwn(ASSETS, path) ? JSON.parse(assetText(path)) : null;
    evidence.outlook = outlook
      ? { cutoff: outlook.cutoff, targetYear: outlook.targetYear, model: outlook.model,
          drivers: outlook.drivers, heldOutCapture: outlook.evaluation.selectedCapture, source: outlook.source.name,
          ...(eventId === 'louisiana' ? { localHeldOut: outlook.evaluation.localHeldOut,
            localCapture: outlook.evaluation.localCapture,
            evidenceSeparation: 'The outlook uses independent annual Landsat-derived tree-cover loss through 2025. It does not verify or extrapolate the NISAR radar candidates.' } : {}),
          definition: 'Relative priority among surviving baseline forest cells. The mapped zones and historical capture are not parcel probabilities.' }
      : { available: false, missing: 'A compatible, independently corroborated multi-year history of mapped disturbance is needed.' };
  }
  pending.add(user);
  try {
    if (env.reserveInterpretation) {
      let reserved;
      try { reserved = await env.reserveInterpretation(); } catch {
        console.error('TerraPhase could not reserve space in the AI report quota.');
        return json({ error: 'AI reports are temporarily unavailable. Try again shortly.' }, 503);
      }
      if (!reserved) return json({ error: 'Today’s AI report limit has been reached. Try again after midnight UTC.' }, 429);
    }
    return json(await interpretPatch(env.OPENAI_API_KEY, evidence));
  } catch (error) {
    return json({ error: error.status === 429
      ? 'OpenAI is temporarily rate limited. Try again shortly.'
      : 'The AI interpretation could not be completed. Try again shortly.' }, error.status ?? 502);
  } finally {
    pending.delete(user);
  }
}

function hazardEvidence(eventId, comparisonDate) {
  const root = '/hazards/' + eventId;
  const data = JSON.parse(assetText(root + '/comparison.json'));
  const [before, ...later] = data.scenes;
  const after = comparisonDate === undefined ? later.at(-1) : later.find(scene => scene.date === comparisonDate);
  if (!after) return null;
  const replayPath = root + '/outlook.json';
  const replay = Object.hasOwn(ASSETS, replayPath) ? JSON.parse(assetText(replayPath)) : null;
  const mapPath = '/hazards/map-sites.json';
  const map = Object.hasOwn(ASSETS, mapPath) ? JSON.parse(assetText(mapPath))[eventId] : null;
  return {
    topic: 'hazard', reportScope: 'event', event: eventId, hazardType: data.type,
    sensor: data.sensor,
    acquisitions: [before, after].map(scene => ({ date: scene.date, track: scene.track, orbit: scene.orbit,
      ids: scene.sources.map(source => source.id) })),
    radarChange: { ...after.change, convention: 'After minus before in dB over shared valid coverage' },
    reference: data.reference && { label: data.reference.label, dates: data.reference.dates, legend: data.reference.legend },
    independentRecord: data.record,
    limitations: data.limits,
    verification: data.verification,
    outlook: data.outlook,
    map: map && { kind: map.kind, note: map.note, locations: map.markers.map(({ name, detail }) => ({ name, detail })) },
    replay: replay && { location: replay.location, horizonMinutes: replay.horizonMinutes, model: replay.model,
      test: replay.heldOut, limitations: 'Historical gauge-only replay. It cannot predict flood extent or support emergency use.' },
  };
}

function droughtEvidence(site) {
  const path = '/drought/' + site + '.json';
  if (!Object.hasOwn(ASSETS, path)) return null;
  const manifest = JSON.parse(assetText(path));
  const [radar, rain] = manifest.layers;
  const scenes = radar.scenes ?? (comparison ??= JSON.parse(assetText('/canopy-watch-louisiana.json'))).scenes;
  const outlookPath = '/drought/' + site + '-outlook.json';
  const outlook = Object.hasOwn(ASSETS, outlookPath) ? JSON.parse(assetText(outlookPath)) : null;
  return {
    topic: 'drought', reportScope: 'event', event: site,
    radar: { measurement: radar.measurement, resolution: radar.resolution, units: radar.units,
      scenes: scenes.map(({ id, date }) => ({ id, date })) },
    rainfall: { source: rain.source, resolution: rain.resolution, dates: rain.dates, baseline: rain.baseline, months: rain.series },
    record: manifest.independentRecord,
    limitations: manifest.limitations,
    outlook: outlook ? {
      definition: outlook.targetDefinition, through: outlook.through, target: outlook.target,
      probability: outlook.probability, thresholdMm: outlook.thresholdMm, division: outlook.division,
      method: outlook.modelLabel, backtest: outlook.backtest,
    } : null,
  };
}

function louisianaEvidence(patchId, dropDb, minimumHa) {
  screening ??= decodeScreening(JSON.parse(assetText('/louisiana-screening.json')));
  const result = screenForest(screening, dropDb, minimumHa);
  const patch = result.patches.find(entry => entry.id === patchId);
  if (patchId !== null && !patch) return null;
  comparison ??= JSON.parse(assetText('/canopy-watch-louisiana.json'));
  const [before, after] = comparison.scenes;
  return {
    area: comparison.label, dates: [before.date, after.date], sceneIds: [before.id, after.id],
    track: before.track, orbit: before.pass === 'A' ? 'ascending' : 'descending',
    frame: before.frame, sensor: 'NISAR L-band', polarization: 'HV with HH context',
    gridSpacingM: screening.grid.spacingM, epsg: screening.grid.epsg,
    historicalTreeCover: 'ESA WorldCover 2021 v200, tree cover and mangroves',
    dropDb, minimumHa, thresholdMarginDb: result.thresholdMarginDb, connectivity: 8,
    summary: { screenedForestHa: result.forestHa, candidateDisturbanceHa: result.flaggedHa,
      candidateShareOfScreenedForestPct: result.flaggedForestPct, candidateCount: result.patches.length },
    scope: 'Candidates within historical forest; not confirmed deforestation. Scene-level statistics are independent of this threshold.',
    patch: patch ? {
      areaHa: patch.areaHa, cells: patch.cells, medianHvDb: patch.hvDb, medianHhDb: patch.hhDb,
      centerM: patch.centerM, waterOrWetlandEdgePct: patch.waterOrWetlandEdgePct,
      edgeDefinition: 'Water or herbaceous wetlands among neighboring cells with mapped nonforest classes.',
    } : null,
    changeConvention: 'after minus before (dB)',
    measurements: screening.numeric ? 'Unclipped float32 radar change calculated from aligned linear-power inputs.'
      : 'Approximate radar change recovered from lossless display; clipped at ±8 dB. Threshold includes a 0.06 dB quantization margin.',
    independentEvidence: 'No independent forest-loss confirmation in this study window.',
  };
}

function rondoniaEvidence(patchId) {
  rondonia ??= JSON.parse(assetText('/rondonia/comparison.json'));
  const patch = rondonia.patches.find(entry => entry.id === patchId);
  if (patchId !== null && !patch) return null;
  return {
    area: rondonia.label, dates: rondonia.scenes.map(scene => scene.date),
    sceneIds: rondonia.scenes.map(scene => scene.id),
    orbit: rondonia.scenes[0].orbit, sensor: 'Sentinel-1 C-band', polarization: 'VH',
    gridSpacingM: rondonia.grid.spacingM, patch: patch ?? null,
    scope: patch?.id === 2 ? 'Selected stable control: do not count its area as forest loss.'
      : 'Curated evidence footprint only, not an exhaustive estimate of scene-wide loss.',
    ...(patch === undefined ? { comparedFootprints: rondonia.patches } : {}),
    repeatDate: rondonia.repeat.date, stableForestMeanChangeDb: rondonia.patches[1].meanDb,
    changeConvention: 'after minus before (dB)',
    measurements: 'Footprint mean calculated from the archived radar data before display clipping.',
    independentEvidence: {
      mappedLoss: rondonia.reference,
      optical: rondonia.optical.map(({ date, validPatchPct }) => ({ date, clearPctOfLossFootprint: validPatchPct })),
      opticalCoverageAppliesTo: 'Mapped forest-loss footprint',
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/interpret') return interpret(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/compare' || url.pathname === '/compare/') {
      return Response.redirect(new URL('/?event=louisiana', url), 302);
    }
    const route = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(ASSETS, route)) return new Response('Not found', { status: 404 });
    const [type, base64] = ASSETS[route];
    return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(base64), value => value.charCodeAt(0)), {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
    });
  },
};

function assetText(path) {
  return new TextDecoder().decode(Uint8Array.from(atob(ASSETS[path][1]), value => value.charCodeAt(0)));
}
