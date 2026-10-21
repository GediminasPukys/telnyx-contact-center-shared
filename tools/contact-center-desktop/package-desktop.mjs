import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {packager} from '@electron/packager';
import {sign} from '@electron/osx-sign';
import {scopeMachOUuid} from './mac-identity.mjs';
import {desktopRoot, stageDesktop} from './package-stage.mjs';

const exec = promisify(execFile);
const product = 'Telnyx Contact Center';
const appId = 'com.telnyx.contactcenter.desktop';

export function packageOptions(platform, args) {
  const options = {platform, arch: platform === 'win32' ? 'x64' : process.arch,
    out: path.join(desktopRoot, 'dist'), installers: false};
  for (const arg of args) {
    if (arg === '--installers') options.installers = true;
    else if (arg.startsWith('--arch=')) options.arch = arg.slice(7);
    else if (arg.startsWith('--out=') && arg.slice(6)) options.out = path.resolve(arg.slice(6));
    else throw Error(`Unknown packaging option: ${arg}`);
  }
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(options.arch)) throw Error('Supported targets: darwin/win32, arm64/x64');
  if (platform === 'darwin' && process.platform !== 'darwin') throw Error('Build and sign macOS packages on macOS');
  return options;
}

async function signMac(directory, electronVersion) {
  const app = path.join(directory, `${product}.app`);
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  const bundles = [app, ...(await fs.readdir(frameworks)).filter(name => name.endsWith('.app')).map(name => path.join(frameworks, name))];
  for (const bundle of bundles) {
    const executables = path.join(bundle, 'Contents', 'MacOS');
    for (const name of await fs.readdir(executables)) {
      const executable = path.join(executables, name);
      await fs.writeFile(executable, scopeMachOUuid(await fs.readFile(executable), `${appId}:${path.relative(app, executable)}`));
    }
  }
  await sign({app, platform: 'darwin', version: electronVersion,
    ...(process.env.CC_DESKTOP_SIGN_IDENTITY
      ? {identity: process.env.CC_DESKTOP_SIGN_IDENTITY}
      : {identity: '-', identityValidation: false, optionsForFile: () => ({hardenedRuntime: false})})});
  return app;
}

async function makeInstallers(options, directory, stage, manifest) {
  const name = `Telnyx-Contact-Center-${manifest.version}-${options.platform}-${options.arch}`;
  if (options.platform === 'darwin') {
    const imageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'telnyx-desktop-dmg-'));
    try {
      await exec('ditto', [path.join(directory, `${product}.app`), path.join(imageRoot, `${product}.app`)]);
      await fs.symlink('/Applications', path.join(imageRoot, 'Applications'));
      const dmg = path.join(options.out, `${name}.dmg`);
      await exec('hdiutil', ['create', '-volname', product, '-srcfolder', imageRoot, '-format', 'UDZO', '-ov', dmg], {maxBuffer: 1024 * 1024});
      const zip = path.join(options.out, `${name}.zip`);
      await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(directory, `${product}.app`), zip]);
      return [dmg, zip];
    } finally { await fs.rm(imageRoot, {recursive: true, force: true}); }
  }
  // electron-builder wraps the prepackaged allowlist payload, not the checkout.
  const {build, Platform, Arch} = await import('electron-builder');
  return build({
    projectDir: stage, prepackaged: directory, publish: 'never',
    targets: Platform.WINDOWS.createTarget(['nsis', 'zip'], options.arch === 'arm64' ? Arch.arm64 : Arch.x64),
    config: {
      appId, productName: product, electronVersion: manifest.devDependencies.electron,
      directories: {output: options.out, buildResources: path.join(desktopRoot, 'assets')},
      artifactName: name + '.${ext}', publish: null, npmRebuild: false,
      toolsets: {nsis: '1.2.1'},
      win: {icon: path.join(desktopRoot, 'assets/icon.ico'), signAndEditExecutable: false},
      nsis: {oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false,
        allowToChangeInstallationDirectory: true, runAfterFinish: false,
        deleteAppDataOnUninstall: false, createDesktopShortcut: false,
        shortcutName: product, artifactName: name + '-setup.${ext}'},
    },
  });
}

export async function packageDesktop(options) {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'telnyx-desktop-package-'));
  try {
    const {manifest, inputs} = await stageDesktop(stage);
    const directories = await packager({
      dir: stage, out: options.out, overwrite: true, platform: options.platform, arch: options.arch,
      electronVersion: manifest.devDependencies.electron, name: product,
      appBundleId: appId, appCategoryType: 'public.app-category.business',
      icon: path.join(desktopRoot, `assets/icon.${options.platform === 'darwin' ? 'icns' : 'ico'}`),
      appVersion: manifest.version, prune: false, asar: false,
      win32metadata: {CompanyName: 'Telnyx', ProductName: product, FileDescription: product},
      extendHelperInfo: {NSLocalNetworkUsageDescription: 'Find and control your authorized desk phones on the local network.'},
      extendInfo: {NSMicrophoneUsageDescription: 'Use your microphone for Contact Center voice calls.',
        NSLocalNetworkUsageDescription: 'Find and control your authorized desk phones on the local network.'},
    });
    const artifacts = [];
    for (const directory of directories) {
      if (options.platform === 'darwin') await signMac(directory, manifest.devDependencies.electron);
      if (options.installers) artifacts.push(...await makeInstallers(options, directory, stage, manifest));
    }
    const {stdout: commit} = await exec('git', ['rev-parse', 'HEAD'], {cwd: desktopRoot});
    const {stdout: changes} = await exec('git', ['status', '--porcelain'], {cwd: desktopRoot});
    const checksums = [];
    for (const artifact of [...new Set(artifacts)].sort()) {
      const hash = createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
      checksums.push(`${hash}  ${path.basename(artifact)}`);
    }
    await fs.writeFile(path.join(options.out, `SHA256SUMS-${options.platform}-${options.arch}.txt`), checksums.join('\n') + '\n');
    await fs.writeFile(path.join(options.out, `build-${options.platform}-${options.arch}.json`), JSON.stringify({
      version: manifest.version, electron: manifest.devDependencies.electron,
      platform: options.platform, arch: options.arch, sourceCommit: commit.trim(), sourceDirty: !!changes.trim(),
      signature: options.platform === 'darwin' ? (process.env.CC_DESKTOP_SIGN_IDENTITY ? 'developer-id-unnotarized' : 'ad-hoc') : 'unsigned',
      publicReleaseReady: false, inputs, artifacts: artifacts.map(file => path.basename(file)),
    }, null, 2) + '\n');
    console.log([...directories, ...artifacts].join('\n'));
  } finally { await fs.rm(stage, {recursive: true, force: true}); }
}
