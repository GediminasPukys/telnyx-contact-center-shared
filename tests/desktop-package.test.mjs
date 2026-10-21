import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {stageDesktop, checkBundleBoundary} from '../tools/contact-center-desktop/package-stage.mjs';
import {packageOptions} from '../tools/contact-center-desktop/package-desktop.mjs';

test('package refuses server dependencies and private source directories', () => {
  for (const input of ['lib/postgres.mjs', 'lib/logger/index.mjs', 'node_modules/@aws-sdk/client-s3/index.js',
    'tools/contact-center-desktop/private/config.json', 'tools/contact-center-desktop/.env',
    'tools/contact-center-desktop/node_modules/pg/index.js', '../outside.mjs']) {
    assert.throws(() => checkBundleBoundary([input]), /desktop bundle dependency/);
  }
  assert.doesNotThrow(() => checkBundleBoundary(['lib/hardphones/device-web.mjs', 'tools/contact-center-desktop/node_modules/ws/lib/websocket.js']));
});

test('Windows defaults to x64 and rejects unsupported/ambiguous package flags', () => {
  assert.equal(packageOptions('win32', []).arch, 'x64');
  assert.equal(packageOptions('win32', ['--arch=arm64', '--installers']).installers, true);
  for (const args of [['--arch=ia32'], ['--out='], ['--publish=always']]) assert.throws(() => packageOptions('win32', args));
});

test('allowlisted payload starts bundled workers without checkout dependencies or server modules', async () => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-package-test-'));
  try {
    const result = await stageDesktop(stage);
    assert.ok(result.inputs.length < 100, 'Unexpected dependency graph expansion');
    assert.ok(!result.inputs.some(input => /postgres|lib\/logger\/|@aws-sdk|node-gyp-build/.test(input)));
    const entries = await fs.readdir(stage);
    for (const name of ['private', 'node_modules', '.env', 'README.md', 'package-lock.json']) assert.ok(!entries.includes(name));
    const exec = promisify(execFile);
    for (const name of ['bridge-worker', 'onboarding-worker']) {
      const url = pathToFileURL(path.join(stage, `${name}.mjs`)).href;
      const script = `process.parentPort={on:(type,handler)=>{if(type!=='message'||typeof handler!=='function')throw Error('Bad IPC');},postMessage:()=>{}}; await import(process.argv[1]); console.log('worker-ready');`;
      const {stdout, stderr} = await exec(process.execPath, ['--input-type=module', '-e', script, url], {cwd: stage, timeout: 10000});
      assert.match(stdout, /worker-ready/); assert.equal(stderr, '');
    }
    const runtime = (await Promise.all(entries.filter(file => /\.(mjs|cjs|js|json|html)$/.test(file)).map(file => fs.readFile(path.join(stage, file), 'utf8')))).join('\n');
    assert.doesNotMatch(runtime, /private-tenant\.example|10\.10\.10\.|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i);
  } finally { await fs.rm(stage, {recursive: true, force: true}); }
});
