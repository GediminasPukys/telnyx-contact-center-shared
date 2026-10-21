const artwork = id => ({ light: `/images/headsets/light/${id}.webp`, dark: `/images/headsets/dark/${id}.webp` });

// Visual identification only. Catalog membership never grants call-control support.
export const EPOS_DEVICE_CATALOG = [
  {
    id: "epos-sc230-usb-ctrl-ii", vendor: "epos", vendorLabel: "EPOS/Sennheiser",
    name: "SC230 USB CTRL II", aliases: ["sc230 usb ctrl ii", "sc 230 usb ctrl ii"],
    role: "headset", images: artwork("epos-sc230-usb-ctrl-ii"),
    status: "Call audio", capabilities: [],
  },
  {
    id: "epos-btd-800-usb",
    vendor: "epos",
    vendorLabel: "EPOS",
    name: "BTD 800 USB for Lync",
    aliases: ["btd 800", "btd800", "btd 800 usb", "btd 800 usb for lync", "1000227"],
    productIds: ["1000227"],
    role: "dongle",
    pairedModelIds: ["epos-mb-pro-2"],
    images: artwork("epos-btd-800-usb"),
    status: "Detected by EPOS Connect as the Bluetooth USB dongle",
    capabilities: ["Bluetooth link", "EPOS Connect bridge", "Call-control transport"],
  },
  {
    id: "epos-mb-pro-2",
    vendor: "epos",
    vendorLabel: "EPOS",
    name: "MB Pro 2",
    aliases: ["mb pro 2", "mbpro2", "mobile business pro 2"],
    role: "headset",
    images: artwork("epos-mb-pro-2"),
    status: "Wireless stereo headset paired through BTD 800",
    capabilities: ["Answer / hang up", "Mute", "Battery", "Call audio"],
  },
  {
    id: "epos-sc260-usb-ii", vendor: "epos", vendorLabel: "EPOS/Sennheiser",
    name: "SC260 USB CTRL II / MS II",
    aliases: ["sc260 usb ctrl ii", "sc 260 usb ctrl ii", "sc260 usb ms ii", "sc 260 usb ms ii"],
    role: "headset", images: artwork("epos-sc260-usb-ii"),
  },
  {
    id: "epos-sc660-usb", vendor: "epos", vendorLabel: "EPOS/Sennheiser",
    name: "SC660 USB", aliases: ["sc660 usb", "sc 660 usb"],
    excludedAliases: ["anc"],
    role: "headset", images: artwork("epos-sc660-usb"),
  },
  {
    id: "epos-impact-860", vendor: "epos", vendorLabel: "EPOS",
    name: "IMPACT 860", aliases: ["impact 860"],
    excludedAliases: ["anc"],
    role: "headset", images: artwork("epos-impact-860"),
  },
  {
    id: "epos-adapt-260", vendor: "epos", vendorLabel: "EPOS",
    name: "ADAPT 260", aliases: ["adapt 260"],
    role: "headset", images: artwork("epos-adapt-260"),
  },
];

export const HEADSET_DEVICE_CATALOG = [
  ...EPOS_DEVICE_CATALOG,
  {
    id: "poly-bt600-usb-a", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "BT600 USB-A", aliases: ["bt600", "bt 600"],
    excludedAliases: ["usb c", "usbc"],
    role: "dongle", pairedModelIds: ["poly-voyager-focus-uc", "poly-voyager-5200"],
    images: artwork("poly-bt600-usb-a"),
  },
  {
    id: "poly-voyager-focus-uc", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "Voyager Focus UC", aliases: ["voyager focus uc", "voyager focus b825", "plt focus"],
    role: "headset", images: artwork("poly-voyager-focus-uc"),
  },
  {
    id: "jabra-pro-930-mono", vendor: "jabra", vendorLabel: "Jabra",
    name: "PRO 930", aliases: ["pro 930", "pro930"],
    excludedAliases: ["duo", "stereo"],
    role: "headset", images: artwork("jabra-pro-930-mono"),
  },
  {
    id: "jabra-evolve-20-stereo", vendor: "jabra", vendorLabel: "Jabra",
    name: "Evolve 20 Stereo", aliases: ["evolve 20 stereo", "evolve 20 uc stereo", "evolve 20 ms stereo", "evolve20 stereo"],
    excludedAliases: ["mono", "se"],
    role: "headset", images: artwork("jabra-evolve-20-stereo"),
  },
  {
    id: "jabra-evolve-40-stereo", vendor: "jabra", vendorLabel: "Jabra",
    name: "Evolve 40 Stereo", aliases: ["evolve 40 stereo", "evolve 40 uc stereo", "evolve 40 ms stereo", "evolve40 stereo"],
    excludedAliases: ["mono"],
    role: "headset", images: artwork("jabra-evolve-40-stereo"),
  },
  {
    id: "jabra-engage-65-stereo", vendor: "jabra", vendorLabel: "Jabra",
    name: "Engage 65 Stereo", aliases: ["engage 65 stereo", "engage65 stereo"],
    excludedAliases: ["mono", "convertible", "se"],
    role: "headset", images: artwork("jabra-engage-65-stereo"),
  },
  {
    id: "jabra-evolve2-65-stereo", vendor: "jabra", vendorLabel: "Jabra",
    name: "Evolve2 65 Stereo", aliases: ["evolve2 65 stereo", "evolve2 65 uc stereo", "evolve2 65 ms stereo"],
    excludedAliases: ["mono", "flex"],
    role: "headset", images: artwork("jabra-evolve2-65-stereo"),
  },
  {
    id: "poly-blackwire-3220", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "Blackwire 3220", aliases: ["blackwire 3220", "blackwire c3220", "c3220", "c 3220"],
    role: "headset", images: artwork("poly-blackwire-3220"),
  },
  {
    id: "poly-blackwire-5220", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "Blackwire 5220", aliases: ["blackwire 5220", "blackwire c5220", "c5220", "c 5220"],
    role: "headset", images: artwork("poly-blackwire-5220"),
  },
  {
    id: "poly-voyager-5200", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "Voyager 5200", aliases: ["voyager 5200", "v5200"],
    role: "headset", images: artwork("poly-voyager-5200"),
  },
  {
    id: "poly-savi-8220", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "Savi 8220", aliases: ["savi 8220", "savi w8220", "savi 8220 uc", "savi 8220 office"],
    role: "headset", images: artwork("poly-savi-8220"),
  },
  {
    id: "poly-voyager-focus-2", vendor: "poly", vendorLabel: "Poly/Plantronics",
    name: "Voyager Focus 2", aliases: ["voyager focus 2", "voyager focus2", "vfocus2"],
    role: "headset", images: artwork("poly-voyager-focus-2"),
  },
];

const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function findHeadsetCatalogEntry(device = {}) {
  const safeDevice = device || {};
  const haystack = ` ${normalize([
    safeDevice.model,
    safeDevice.productName,
  ].filter(Boolean).join(" "))} `;

  return HEADSET_DEVICE_CATALOG.find((entry) =>
    (!safeDevice.vendor || safeDevice.vendor === entry.vendor) &&
    !entry.excludedAliases?.some(alias => haystack.includes(` ${normalize(alias)} `)) &&
    (entry.aliases.some((alias) => haystack.includes(` ${normalize(alias)} `)) ||
      entry.productIds?.includes(String(safeDevice.productId || "")))
  ) || null;
}

export function getDeviceCatalogForVendor(vendor) {
  return HEADSET_DEVICE_CATALOG.filter(entry => entry.vendor === vendor);
}

export function getPairedHeadsetModels(device) {
  const adapter = findHeadsetCatalogEntry(device);
  return HEADSET_DEVICE_CATALOG.filter(entry => entry.vendor === device?.vendor
    && entry.role === "headset" && adapter?.pairedModelIds?.includes(entry.id));
}

/** Presentation only: a user-selected model never changes endpoint identity or capabilities. */
export function getHeadsetDisplay(device, pairedModelId) {
  const paired = getPairedHeadsetModels(device).find(entry => entry.id === pairedModelId);
  return {
    name: paired?.name || device?.model || device?.productName,
    artworkDevice: paired ? { vendor: paired.vendor, model: paired.name } : device,
    adapterName: paired ? device.model || device.productName : null,
    modelSource: paired ? "user" : "device",
    pairedModelId: paired?.id || "",
  };
}
