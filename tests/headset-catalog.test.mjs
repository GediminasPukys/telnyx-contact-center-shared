import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { findHeadsetCatalogEntry, getHeadsetDisplay, HEADSET_DEVICE_CATALOG } from '../lib/headsets/headset-device-catalog.js';

test('catalog identifies named models and never substitutes a related headset or paired dongle', () => {
  assert.equal(findHeadsetCatalogEntry({ vendor:'epos', model:'Sennheiser SC230 USB CTRL II (1395:004d)' })?.id, 'epos-sc230-usb-ctrl-ii');
  assert.equal(findHeadsetCatalogEntry({ vendor:'epos', model:'EPOS MB Pro 2' })?.id, 'epos-mb-pro-2');
  assert.equal(findHeadsetCatalogEntry({ vendor:'epos', model:'BTD 800 USB for Lync' })?.role, 'dongle');
  assert.equal(findHeadsetCatalogEntry({ vendor:'epos', productId:'1000227' })?.role, 'dongle');
  assert.equal(findHeadsetCatalogEntry({ vendor:'jabra', model:'Jabra Evolve2 65 MS Stereo' })?.id, 'jabra-evolve2-65-stereo');
  assert.equal(findHeadsetCatalogEntry({ vendor:'poly', model:'Plantronics Voyager Focus 2 UC' })?.id, 'poly-voyager-focus-2');
  for (const model of ['MB Pro 1', 'SC320 USB CTRL II', 'SC2300 USB CTRL II', 'Evolve2 65 Flex', 'Evolve2 65 Mono', 'Jabra Link 380', 'BT700', 'Voyager Focus 20']) {
    assert.equal(findHeadsetCatalogEntry({model}), null, model);
  }
  assert.equal(findHeadsetCatalogEntry({vendor:'poly',model:'Sennheiser SC230 USB CTRL II'}),null);
  assert.equal(findHeadsetCatalogEntry({serialNumber:'mb-pro-2',id:'mb-pro-2'}),null);
  assert.equal(findHeadsetCatalogEntry(null),null);
});
test('paired model is explicit presentation only, and invalid or unrelated choices are ignored', () => {
  const dongle = Object.freeze({ vendor: 'epos', id: 'adapter', model: 'Sennheiser BTD 800 USB for Lync', controlReady: false });
  assert.equal(getHeadsetDisplay(dongle).name, dongle.model);
  const display = getHeadsetDisplay(dongle, 'epos-mb-pro-2');
  assert.equal(display.name, 'MB Pro 2'); assert.equal(display.adapterName, dongle.model);
  assert.equal(display.modelSource, 'user'); assert.equal(findHeadsetCatalogEntry(display.artworkDevice).id, 'epos-mb-pro-2');
  assert.equal(dongle.controlReady, false);
  for (const id of ['missing', 'jabra-evolve2-65-stereo', 'epos-sc230-usb-ctrl-ii', '__proto__']) {
    assert.equal(getHeadsetDisplay(dongle, id).name, dongle.model);
  }
  assert.equal(getHeadsetDisplay({ vendor: 'epos', model: 'SC230 USB CTRL II' }, 'epos-mb-pro-2').name, 'SC230 USB CTRL II');
  assert.equal(getHeadsetDisplay(null, 'epos-mb-pro-2').pairedModelId, '');
});
test('expanded catalog matches named variants without substituting mono, ANC, or unrelated generations', () => {
  const models = {
    'Jabra PRO 930 (0b0e:1016)': 'jabra-pro-930-mono',
    'Jabra PRO930 MS': 'jabra-pro-930-mono',
    'Jabra Evolve 20 UC Stereo': 'jabra-evolve-20-stereo',
    'Jabra Evolve 40 MS Stereo': 'jabra-evolve-40-stereo',
    'Jabra Engage 65 Stereo': 'jabra-engage-65-stereo',
    'Sennheiser SC 260 USB CTRL II': 'epos-sc260-usb-ii',
    'EPOS SC260 USB MS II': 'epos-sc260-usb-ii',
    'EPOS IMPACT SC 660 USB ML': 'epos-sc660-usb',
    'EPOS IMPACT 860': 'epos-impact-860',
    'EPOS ADAPT 260': 'epos-adapt-260',
    'Plantronics Blackwire 3220': 'poly-blackwire-3220',
    'Plantronics C3220': 'poly-blackwire-3220',
    'Poly Blackwire 5220 USB-C': 'poly-blackwire-5220',
    'Plantronics C5220': 'poly-blackwire-5220',
    'Poly Voyager 5200 UC': 'poly-voyager-5200',
    'Plantronics Savi W8220': 'poly-savi-8220',
    'Plantronics BT600 (047f:02f7)': 'poly-bt600-usb-a',
    'Poly Voyager Focus UC': 'poly-voyager-focus-uc',
    'PLT Focus': 'poly-voyager-focus-uc',
  };
  for (const [model, id] of Object.entries(models)) assert.equal(findHeadsetCatalogEntry({model})?.id, id, model);
  for (const model of [
    'Jabra PRO 930 DUO', 'Jabra PRO 930 Stereo', 'Jabra PRO 9300',
    'Jabra Evolve 20 Mono', 'Jabra Evolve 20 SE Stereo', 'Jabra Evolve 40',
    'Jabra Evolve2 40 Stereo', 'Jabra Engage 65 Convertible', 'Jabra Engage 65 Stereo SE',
    'Jabra Evolve2 65 Stereo Flex', 'EPOS SC660 USB ML ANC', 'EPOS SC260 USB',
    'EPOS IMPACT 860 ANC', 'EPOS ADAPT 261', 'Poly Blackwire 3210',
    'Poly Blackwire 5210', 'Poly Voyager 5200X', 'Poly Savi 8210', 'Poly BT600 USB-C',
  ]) assert.equal(findHeadsetCatalogEntry({model}), null, model);
  // Conflicting explicit variant metadata must not be hidden by a matching product label.
  assert.equal(findHeadsetCatalogEntry({model:'Mono',productName:'Jabra Evolve 40 MS Stereo'}),null);
});
test('BT600 artwork never infers its paired headset or capabilities', () => {
  const device = { vendor: 'poly', model: 'Plantronics BT600', capabilities: { hold: false } };
  assert.equal(getHeadsetDisplay(device).name, 'Plantronics BT600');
  const display = getHeadsetDisplay(device, 'poly-voyager-focus-uc');
  assert.equal(display.name, 'Voyager Focus UC');
  assert.equal(display.adapterName, 'Plantronics BT600');
  assert.equal(display.modelSource, 'user');
  assert.equal(device.capabilities.hold, false);
  assert.equal(getHeadsetDisplay(device, 'poly-voyager-focus-2').name, 'Plantronics BT600');
});
test('every catalog entry has matching transparent 320px theme assets and a saved original', async () => {
  assert.equal(new Set(HEADSET_DEVICE_CATALOG.map(entry=>entry.id)).size,HEADSET_DEVICE_CATALOG.length);
  for (const entry of HEADSET_DEVICE_CATALOG) {
    await access(new URL('../public/images/headsets/source/' + entry.id + '.png', import.meta.url));
    const buffers = [];
    for (const theme of ['light','dark']) {
      assert.match(entry.images[theme], new RegExp(`^/images/headsets/${theme}/[a-z0-9-]+\\.webp$`));
      const buffer=await readFile(new URL('../public' + entry.images[theme], import.meta.url));
      const metadata=await sharp(buffer).metadata();
      assert.equal(metadata.width,320,entry.id);assert.equal(metadata.height,320,entry.id);assert.equal(metadata.hasAlpha,true,entry.id);
      buffers.push(buffer);
    }
    assert.deepEqual(buffers[0],buffers[1],entry.id+' must retain its geometry between themes');
  }
});
