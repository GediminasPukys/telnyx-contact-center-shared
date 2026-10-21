export const HEADSET_VENDORS = ["jabra", "epos", "poly"];
export function normalizeHeadsetSettings(value = {}) {
  return { enabled: value?.enabled !== false, disabledVendors: HEADSET_VENDORS.filter(v => Array.isArray(value?.disabledVendors) && value.disabledVendors.includes(v)) };
}
export function parseHeadsetSettings(value) {
  if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.disabledVendors) || value.disabledVendors.some(v => !HEADSET_VENDORS.includes(v))) throw new Error("Supply enabled and a list of disabled headset vendors.");
  return normalizeHeadsetSettings(value);
}
export function headsetPolicy(user, settings = {}) {
  const configuration = normalizeHeadsetSettings(settings?.headsets);
  return { enabled: configuration.enabled && (user.headset_controls_enabled ?? user.experimental_features) === true,
    vendors: HEADSET_VENDORS.filter(vendor => !configuration.disabledVendors.includes(vendor)), userId: String(user.id) };
}
