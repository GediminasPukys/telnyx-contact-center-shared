import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

export const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(desktopRoot, '../..');
export const desktopFiles = [
  'main.cjs', 'auth-main.cjs', 'auth-flow.cjs', 'auth-loopback.cjs', 'auth-result-page.cjs', 'onboarding-main.cjs', 'secure-store.cjs',
  'headset-permissions.cjs', 'environments.cjs', 'load-contact-center.cjs',
  'desktop-preload.cjs', 'settings-preload.cjs', 'status-preload.cjs',
  'settings.html', 'settings.js', 'settings.css', 'connection-error.html',
  'connection-error.js', 'status.html', 'status.js', 'status.css',
];
const desktopAssets = ['icon.png', 'icon.icns', 'icon.ico', 'telnyx-logo.png'];

export function checkBundleBoundary(inputs) {
  for (const input of inputs) {
    const relative = path.relative(repositoryRoot, path.resolve(repositoryRoot, input)).split(path.sep).join('/');
    if (!relative.startsWith('lib/hardphones/') &&
        !(relative.startsWith('tools/contact-center-desktop/') && !relative.includes('/node_modules/')) &&
        !relative.startsWith('tools/contact-center-desktop/node_modules/ws/') &&
        !relative.startsWith('node_modules/ws/') &&
        relative !== 'lib/telephony/native-phone-state.mjs') {
      throw Error(`Unexpected desktop bundle dependency: ${relative}`);
    }
    if (/(?:^|\/)(?:private|\.env[^/]*|dist|backups)(?:\/|$)/.test(relative)) {
      throw Error(`Private desktop bundle dependency: ${relative}`);
    }
  }
}

// Stage only runtime files. Never copy a checkout, user profile, .env, private/
// directory or test evidence. Transitive worker imports are audited as well.
export async function stageDesktop(stage) {
  const manifest = JSON.parse(await fs.readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
  await fs.mkdir(path.join(stage, 'assets'), {recursive: true});
  for (const file of desktopFiles) await fs.copyFile(path.join(desktopRoot, file), path.join(stage, file));
  for (const file of desktopAssets) await fs.copyFile(path.join(desktopRoot, 'assets', file), path.join(stage, 'assets', file));
  const inputs = new Set();
  for (const name of ['bridge-worker', 'onboarding-worker', 'policy', 'discovery']) {
    const result = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [path.join(desktopRoot, `${name}.mjs`)], outfile: path.join(stage, `${name}.mjs`),
      bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
      // Node's built-ins cover these optional ws accelerators. Do not embed
      // a native addon compiled for the build host in a cross-platform app.
      define: {'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"'},
      legalComments: 'eof',
      banner: {js: "import { createRequire as __desktopCreateRequire } from 'node:module'; const require = __desktopCreateRequire(import.meta.url);"},
      plugins: [{name: 'desktop-diagnostics', setup(builder) {
        builder.onResolve({filter: /diagnostic-logger\.mjs$/}, args => {
          if (path.resolve(args.resolveDir, args.path) !== path.join(repositoryRoot, 'lib/diagnostic-logger.mjs')) return;
          return {path: path.join(desktopRoot, 'desktop-diagnostics.mjs')};
        });
      }}],
    });
    checkBundleBoundary(Object.keys(result.metafile.inputs));
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
  }
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({
    name: 'telnyx-contact-center-desktop', productName: 'Telnyx Contact Center',
    version: manifest.version, main: 'main.cjs', description: manifest.description,
    author: 'Telnyx', license: 'MIT',
  }, null, 2));
  await fs.copyFile(path.join(repositoryRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
  await fs.writeFile(path.join(stage, 'THIRD-PARTY-NOTICES.txt'),
    `ws\n${await fs.readFile(path.join(desktopRoot, 'node_modules/ws/LICENSE'), 'utf8')}`);
  for (const file of desktopFiles.filter(name => name.endsWith('.cjs'))) {
    for (const match of (await fs.readFile(path.join(stage, file), 'utf8')).matchAll(/(?:require|import)\(['"](\.\/[^'"]+)['"]\)/g)) {
      await fs.access(path.join(stage, match[1]));
    }
  }
  return {manifest, inputs: [...inputs].sort()};
}
