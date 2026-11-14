import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const comparison = await readFile('web/canopy-watch-louisiana.json');
const screeningData = JSON.parse(await readFile('web/louisiana-screening.json', 'utf8'));
const checksum = createHash('sha256').update(comparison).digest('hex');
if (screeningData.comparisonSha256 !== checksum) {
  throw Error('Regenerate screening inputs for this comparison before building.');
}

const mime = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  webp: 'image/webp',
  png: 'image/png',
};
const assets = Object.fromEntries(await Promise.all((await readdir('web', { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => entry.parentPath.replace(/^web\/?/, '')
    .split('/').filter(Boolean).concat(entry.name).join('/')).sort().map(async file => {
  const type = mime[file.split('.').pop()];
  if (!type) throw Error('Unsupported comparison asset ' + file);
  return ['/' + file, [type, (await readFile('web/' + file)).toString('base64')]];
})));
const screening = (await readFile('web/screening.js', 'utf8')).replace(/^export /gm, '');
const interpreter = await readFile('worker/interpreter.js', 'utf8');
const worker = await readFile('worker/index.js', 'utf8');
await mkdir('dist/server', { recursive: true });
await writeFile('dist/server/index.js',
  'const ASSETS = ' + JSON.stringify(assets) + ';\n' + screening + '\n' + interpreter + '\n' + worker);
