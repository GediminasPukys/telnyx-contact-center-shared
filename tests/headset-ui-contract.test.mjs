import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from './helpers/ui-source.mjs';
const src = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('mini owns headset lifecycle and expanded phone shares call commands', () => {
  const mini = src('components/softphone-mini.jsx'), full = src('components/softphone.jsx');
  assert.match(mini, /startHeadsetSession/); assert.match(mini, /createHeadsetCommandController/); assert.match(mini, /useHeadsetAccess/);
  assert.doesNotMatch(full, /startHeadsetSession|getHeadsetControlService|<audio/); assert.match(full, /callStateActions/); assert.doesNotMatch(full, /getHeadsetAudioRouter|enumerateDevices|showRegionList|showMicList|showSpkList/);
});
test('headset panel shares modal tokens, compact buttons and loading skeletons', () => {
  const ui = src('components/headsets/HeadsetStatusBadge.jsx');
  assert.match(ui, /<Button/); assert.match(ui, /max-w-lg/); assert.match(ui, /rounded-3xl/); assert.match(ui, /var\(--modal,/); assert.match(ui, /Skeleton/);
  assert.match(ui, /requestPermission\("poly"\)/); assert.match(ui, /requestPermission\("jabra"\)/);
  assert.doesNotMatch(ui, /sendTestCommand\("(muteOn|muteOff|holdOn)"\)/);
});
test('runtime policy endpoints require authenticated user and explicit settings permissions', () => {
  const route = src('app/api/admin/headsets/route.js'); assert.match(route, /withPermission\("system_settings:read"/); assert.match(route, /withPermission\("system_settings:update"/);
  assert.match(src('app/api/user/headsets/route.js'), /withPermission\("authenticated"/);
});
