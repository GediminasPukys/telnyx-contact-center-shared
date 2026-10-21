// The desktop shell owns WebHID permissioning; Chromium's browser chooser is
// not provided by Electron. Limit automatic discovery to supported headset
// vendors with a Telephony collection, on the configured Contact Center origin.
const vendors = new Set([0x047f, 0x0b0e, 0x1395]);
// EPOS Connect exposes its authenticated SDK on this computer's loopback.
// LAN discovery remains in the native phone bridge, not the web document.
const permissions = new Set(['media', 'notifications', 'hid', 'speaker-selection', 'loopback-network']);
const hasTelephony = collections => Array.isArray(collections) && collections.some(collection =>
  collection.usagePage === 0x0b || hasTelephony(collection.children));
const isHeadset = device => vendors.has(device?.vendorId) && hasTelephony(device.collections);
const sameOrigin = (value, origin) => {
  try { return new URL(value).origin === origin; } catch { return false; }
};

function installHeadsetPermissions({ session, webContents, origin, chooseDevice }) {
  const trusted = url => !webContents.isDestroyed() && sameOrigin(webContents.getURL(), origin) && sameOrigin(url, origin);
  session.setPermissionCheckHandler((wc, permission, url) =>
    wc === webContents && trusted(url) && permissions.has(permission));
  session.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(wc === webContents && trusted(details.requestingUrl || wc.getURL()) && permissions.has(permission)));
  session.setDevicePermissionHandler(details =>
    details.deviceType === 'hid' && trusted(details.origin) && isHeadset(details.device));

  const select = async (event, details, callback) => {
    event.preventDefault();
    // Reject requests from frames other than our main Contact Center document.
    if (details.frame !== webContents.mainFrame || !trusted(details.frame?.url)) { callback(''); return; }
    const devices = (details.deviceList || []).filter(isHeadset);
    try {
      const selected = devices.length === 1 ? devices[0] : devices.length ? await chooseDevice(devices) : null;
      callback(trusted(details.frame?.url) && devices.includes(selected) ? selected.deviceId : '');
    } catch { callback(''); }
  };
  session.on('select-hid-device', select);
  webContents.once('destroyed', () => session.removeListener('select-hid-device', select));
}
module.exports = { installHeadsetPermissions, isHeadset };
