let screening;
let comparison;
let rondonia;
const pending = new Set();

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
  const { eventId = 'louisiana', patchId, dropDb, minimumHa } = selection ?? {};
  if (!Number.isInteger(patchId) || !['louisiana', 'rondonia'].includes(eventId)) {
    return json({ error: 'Invalid event or footprint.' }, 400);
  }
  if (eventId === 'louisiana' && !validSettings(dropDb, minimumHa)) {
    return json({ error: 'Invalid screening settings.' }, 400);
  }
  const evidence = eventId === 'rondonia' ? rondoniaEvidence(patchId) : louisianaEvidence(patchId, dropDb, minimumHa);
  if (!evidence) return json({ error: 'This footprint is outside the selected event.' }, 404);
  pending.add(user);
  try {
    return json(await interpretPatch(env.OPENAI_API_KEY, evidence));
  } catch (error) {
    return json({ error: error.status === 429
      ? 'OpenAI is temporarily rate limited. Try again shortly.'
      : 'The AI interpretation could not be completed. Try again shortly.' }, error.status ?? 502);
  } finally {
    pending.delete(user);
  }
}

function louisianaEvidence(patchId, dropDb, minimumHa) {
  screening ??= decodeScreening(JSON.parse(assetText('/louisiana-screening.json')));
  const patch = screenForest(screening, dropDb, minimumHa).patches.find(entry => entry.id === patchId);
  if (!patch) return null;
  comparison ??= JSON.parse(assetText('/canopy-watch-louisiana.json'));
  const [before, after] = comparison.scenes;
  return {
    area: comparison.label, dates: [before.date, after.date],
    track: before.track, orbit: before.pass === 'A' ? 'ascending' : 'descending',
    frame: before.frame, sensor: 'NISAR L-band', polarization: 'HV with HH context',
    gridSpacingM: screening.grid.spacingM, epsg: screening.grid.epsg,
    historicalTreeCover: 'ESA WorldCover 2021 v200, tree cover and mangroves',
    dropDb, minimumHa,
    patch: {
      areaHa: patch.areaHa, cells: patch.cells, medianHvDb: patch.hvDb, medianHhDb: patch.hhDb,
      centerM: patch.centerM, waterOrWetlandEdgePct: patch.waterOrWetlandEdgePct,
      edgeDefinition: 'Water or herbaceous wetlands among neighboring cells with mapped nonforest classes.',
    },
    changeConvention: 'after minus before (dB)',
    measurements: 'Approximate radar change recovered from lossless display; clipped at ±8 dB.',
    independentEvidence: 'No independent forest-loss confirmation in this study window.',
  };
}

function rondoniaEvidence(patchId) {
  rondonia ??= JSON.parse(assetText('/rondonia/comparison.json'));
  const patch = rondonia.patches.find(entry => entry.id === patchId);
  if (!patch) return null;
  return {
    area: rondonia.label, dates: rondonia.scenes.map(scene => scene.date),
    orbit: rondonia.scenes[0].orbit, sensor: 'Sentinel-1 C-band', polarization: 'VH',
    gridSpacingM: rondonia.grid.spacingM, patch,
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
