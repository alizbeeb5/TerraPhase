import { randomUUID } from 'node:crypto';

function apiError(status, error) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function createHandler(config, worker, { loadKey, reserveInterpretation }) {
  return async request => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const { method } = request;
    if (path !== '/api/interpret') {
      if (path.startsWith('/api/')) return apiError(404, 'TerraPhase API route unavailable.');
      return worker.fetch(request, {});
    }
    if (method !== 'POST') return apiError(405, 'Use POST to request interpretation.');
    if (request.headers.get('origin') !== config.origin) {
      return apiError(403, 'Open TerraPhase to request interpretation.');
    }
    let key;
    try { key = await loadKey(); } catch {
      console.error('TerraPhase could not load the configured OpenAI secret.');
      return apiError(503, 'AI reports are temporarily unavailable. Check the server configuration.');
    }
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    // This ID belongs to the request. The public endpoint uses a shared daily quota.
    headers.set('oai-authenticated-user-id', randomUUID());
    return worker.fetch(new Request(new URL('/api/interpret', config.origin), {
      method, headers, body: request.body, duplex: 'half',
    }), { OPENAI_API_KEY: key, reserveInterpretation });
  };
}
