import { headsetControlReady } from './headset-control-service.mjs';
import { findHeadsetCatalogEntry } from './headset-device-catalog.js';

const usbVendors = { poly: 0x047f, jabra: 0x0b0e, epos: 0x1395 };
const name = value => String(value || '').toLowerCase().replace(/\([a-f\d]{4}:[a-f\d]{4}\)/gi, '').replace(/[^a-z\d]+/g, ' ').trim();

const usbId = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 0xffff ? number : null;
};

/** Match only an unambiguous, authorized control endpoint, never a vendor alone. */
export function findAudioControlDevice(suggestion, devices = []) {
  if (!suggestion?.name) return null;
  const usb = suggestion.name.match(/\(([a-f\d]{4}):([a-f\d]{4})\)/i);
  const catalog = findHeadsetCatalogEntry({ model: suggestion.name });
  const candidates = devices.filter(headsetControlReady).map(device => {
    const vendor = usbId(device.usbVendorId ?? device.vendorId) || usbVendors[device.vendor];
    // EPOS Connect ProductId is an SDK/catalog identifier, not necessarily USB PID.
    const product = usbId(device.usbProductId ?? (device.transport === 'epos-websocket' ? null : device.productId));
    if (usb && vendor && vendor !== parseInt(usb[1], 16)) return { device, score: 0 };
    if (usb && product && vendor) return { device, score: product === parseInt(usb[2], 16) ? 3 : 0 };
    if ([device.model, device.productName].some(model => model && name(model) === name(suggestion.name))) return { device, score: 2 };
    return { device, score: catalog && findHeadsetCatalogEntry(device)?.id === catalog.id ? 1 : 0 };
  });
  const highest = Math.max(0, ...candidates.map(candidate => candidate.score));
  const matches = candidates.filter(candidate => candidate.score === highest && highest > 0);
  return matches.length === 1 ? matches[0].device : null;
}
