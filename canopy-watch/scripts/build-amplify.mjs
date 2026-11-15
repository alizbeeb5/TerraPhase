import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readBuildConfig } from '../hosting/amplify/config.mjs';

const config = readBuildConfig(process.env);
await import('./build.mjs');

const output = new URL('../../.amplify-hosting/', import.meta.url);
const staged = new URL('../../.amplify-hosting-staging/', import.meta.url);
const compute = new URL('compute/default/', staged);
const buildSource = new URL('../', import.meta.url);
const target = { kind: 'Compute', src: 'default' };
const manifest = {
  version: 1,
  framework: { name: 'terraphase', version: '1.0.0' },
  routes: [
    { path: '/api/*', target },
    { path: '/*.*', target: { kind: 'Static' }, fallback: target },
    { path: '/*', target },
  ],
  computeResources: [{ name: 'default', runtime: 'nodejs22.x', entrypoint: 'server.mjs' }],
};

await rm(staged, { recursive: true, force: true });
await mkdir(compute, { recursive: true });
try {
  await cp(new URL('web/', buildSource), new URL('static/', staged), { recursive: true });
  await cp(new URL('node_modules/', buildSource), new URL('node_modules/', compute), { recursive: true });
  for (const filename of ['server.mjs', 'handler.mjs', 'limit.mjs']) {
    await cp(new URL('hosting/amplify/' + filename, buildSource), new URL(filename, compute));
  }
  await cp(new URL('dist/server/index.js', buildSource), new URL('worker.mjs', compute));
  await writeFile(new URL('config.json', compute), JSON.stringify(config) + '\n');
  await writeFile(new URL('deploy-manifest.json', staged), JSON.stringify(manifest, null, 2) + '\n');
  await rm(output, { recursive: true, force: true });
  await rename(staged, output);
} finally {
  await rm(staged, { recursive: true, force: true });
}
console.log('Built .amplify-hosting with static assets and the TerraPhase API.');
