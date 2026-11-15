const MODEL = 'gpt-5.4-mini-2026-03-17';
const SCHEMA = {
  type: 'object',
  properties: {
    observation: { type: 'string' },
    explanation: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
  },
  required: ['observation', 'explanation', 'alternatives', 'verification'],
  additionalProperties: false,
};
const INSTRUCTIONS = `Interpret a satellite comparison for the selected footprint. Use only the
supplied observations. Separate measurements from inferred causes. Respect the supplied scope,
quality limitations, screening threshold, quantization margin, and area denominator. Never describe
a selected footprint as exhaustive scene-wide loss. Never turn candidate area into confirmed loss. State the change, area, sensor, and polarization. Say whether change is a
mean or median when known. Describe the radar footprint area as such. For a candidate with no
independent evidence, explain plausible canopy change and alternatives such as moisture or inundation.
When annual mapped tree-cover loss, optical dates, repeat radar, or a nearby stable control are
available, explain what they support for the selected footprint. Treat annual loss as an interval,
and the stable footprint as local context. Handle small changes in a stable footprint without claiming loss.
Report remaining uncertainty and specific verification steps. Avoid claims about exact clearing dates,
causes, diagnoses of legality, landowners, or confidence scores. Use short, plain-language sentences.`;

const REPORT_SCHEMA = { ...SCHEMA,
  properties: { ...SCHEMA.properties, actions: { type: 'array', items: { type: 'string' } } },
  required: [...SCHEMA.required, 'actions'],
};
const REPORT_INSTRUCTIONS = `
Create an evidence report for the requested scope. Tie key claims to the supplied scene dates,
measurements or named source; stop at what the evidence supports. Keep observed loss and a
modeled outlook separate. A ranked zone can prioritize monitoring and has no calibrated probability.
Return a concrete, ordered verification checklist and a distinct list of conditional response actions.
For a radar-only candidate prioritize cross-checks, including moisture or inundation. For an independently
corroborated loss footprint, propose documenting the location and asking the relevant land manager
to review the boundary and determine the cause. For the stable control prioritize monitoring.
Describe prevention measures as options conditional on a verified driver. Do not invent local
authority names, promise that an action will stop loss, or advise direct confrontation.`;

const DROUGHT_INSTRUCTIONS = `Write a concise drought evidence report using only the supplied observations.
Separate regional NOAA rainfall anomalies, the referenced drought assessment, and the radar images.
Each browse image has separate display scaling; never infer a numerical change or soil moisture from the previews.
Radar alone cannot diagnose drought. Do not invent a site-level drought category or claim the rainfall series covers
days beyond its listed dates. The experimental outlook, if present, is a probability of a regional three-month
rainfall total below a historical percentile. It is not a drought probability, an official weather forecast,
or a location-specific prediction. Report what to verify with gauges, later scenes, or independent soil moisture,
then give practical conditional follow-up steps. Use short sentences and cite the supplied agency and dates.`;

async function interpretPatch(key, evidence) {
  const report = Boolean(evidence.reportScope);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: MODEL, store: false, max_output_tokens: report ? 1300 : 700,
      instructions: evidence.topic === 'drought' ? DROUGHT_INSTRUCTIONS : INSTRUCTIONS + (report ? REPORT_INSTRUCTIONS : ''),
      input: JSON.stringify(evidence),
      text: { format: { type: 'json_schema', name: 'patch_interpretation', strict: true, schema: report ? REPORT_SCHEMA : SCHEMA } },
    }),
  });
  if (!response.ok) {
    console.warn('OpenAI interpretation status', response.status);
    const error = new Error('The OpenAI interpretation service could not complete the request.');
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }
  const result = await response.json();
  const content = result.output?.flatMap(item => item.content ?? []) ?? [];
  if (result.status !== 'completed' || content.some(item => item.type === 'refusal')) {
    throw Error('The model did not return a complete interpretation. Try again.');
  }
  const answer = JSON.parse(content.find(item => item.type === 'output_text')?.text ?? '{}');
  if (![answer.observation, answer.explanation].every(value => typeof value === 'string' && value.trim())
    || ![answer.alternatives, answer.verification, ...(report ? [answer.actions] : [])].every(values =>
      Array.isArray(values) && values.length && values.every(value => typeof value === 'string' && value.trim()))) {
    throw Error('The model returned incomplete interpretation fields. Try again.');
  }
  return { ...answer, model: MODEL };
}
