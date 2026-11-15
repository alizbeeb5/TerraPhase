// Shared, read-only event contract for the globe. Coordinates locate the study areas.
export const events = Object.freeze({
  rondonia: Object.freeze({ id: 'rondonia', name: 'Rondônia forest change', location: 'Rondônia, Brazil',
    center: { lat: -9.6106, lon: -63.79189 }, beforeDate: '2019-08-22', afterDate: '2022-08-30',
    status: 'ready', path: '/rondonia/comparison.json', band: 'VH', title: 'Rondônia, Brazil', defaultView: 'optical' }),
  louisiana: Object.freeze({ id: 'louisiana', name: 'Louisiana radar candidates', location: 'Louisiana, USA',
    center: { lat: 29.91354, lon: -90.28041 }, beforeDate: '2026-06-21', afterDate: '2026-09-01',
    status: 'ready', path: '/canopy-watch-louisiana.json', band: 'HV', title: 'Louisiana, USA', defaultView: 'radar' }),
});
export async function listEvents() {
  return Object.values(events).map(({ id, name, location, center, beforeDate, afterDate, status }) =>
    ({ id, name, location, center: { ...center }, beforeDate, afterDate, status }));
}
