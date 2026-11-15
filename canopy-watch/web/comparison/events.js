// Shared, read-only event contract for the globe. Coordinates locate the study areas.
export const events = Object.freeze({
  rondonia: Object.freeze({ id: 'rondonia', name: 'Rondônia forest change', location: 'Rondônia, Brazil',
    center: { lat: -9.6106, lon: -63.79189 }, beforeDate: '2019-08-22', afterDate: '2022-08-30',
    type: 'forest-disturbance', capabilities: { comparison: true, forecast: false }, status: 'ready', manifestPath: '/rondonia/comparison.json', path: '/rondonia/comparison.json', band: 'VH', title: 'Rondônia, Brazil', defaultView: 'optical' }),
  louisiana: Object.freeze({ id: 'louisiana', name: 'Louisiana radar candidates', location: 'Louisiana, USA',
    center: { lat: 29.91354, lon: -90.28041 }, beforeDate: '2026-06-21', afterDate: '2026-09-01',
    type: 'forest-disturbance', capabilities: { comparison: true, forecast: false }, status: 'ready', manifestPath: '/canopy-watch-louisiana.json', path: '/canopy-watch-louisiana.json', band: 'HV', title: 'Louisiana, USA', defaultView: 'radar' }),
});
export async function listEvents() {
  return structuredClone([...Object.values(events), {
    id: 'louisiana-drought', type: 'drought', name: 'Louisiana rainfall and radar',
    location: 'Southeast Louisiana, USA', center: { lat: 29.91354, lon: -90.28041 },
    beforeDate: '2026-06-21', afterDate: '2026-09-01', status: 'provisional',
    capabilities: { comparison: true, forecast: false, precipitationAnomaly: true, soilMoisture: false },
    evidenceLayers: ['gamma0-backscatter', 'precipitation-anomaly'],
    manifestPath: '/drought/louisiana.json'
  }].map(event => ({ evidenceLayers: ['radar-backscatter', 'forest-reference'], ...event })));
}
export function filterEvents(events, type = 'all', query = '') {
  const key = value => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const needle = key(query.trim());
  return events.filter(event => (type === 'all' || event.type === type)
    && key(event.name + ' ' + event.location).includes(needle));
}
export function eventLink(event, params = new URLSearchParams(), back = false) {
  const next = new URLSearchParams(params);
  next.delete('event'); next.delete('selected');
  next.set(back ? 'selected' : 'event', event.id);
  return '/?' + next;
}
