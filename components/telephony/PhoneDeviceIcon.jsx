"use client";

import { Monitor, Smartphone, Tablet, PhoneOff, PhoneCall } from "lucide-react";

/** The selected audio endpoint, independent of connection/quality status. */
export default function PhoneDeviceIcon({ kind, formFactor, ...props }) {
  const Icon = kind === "none" ? PhoneOff
    : kind === "deskphone" || kind === "sip" ? PhoneCall
    : kind === "ios" || kind === "android" ? (formFactor === "tablet" ? Tablet : Smartphone)
    : Monitor;
  // A desk telephone silhouette remains legible at the mini phone's 16px size.
  if (kind === "deskphone") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-device-kind={kind} {...props}>
    <rect x="3" y="3" width="5" height="18" rx="2" /><path d="M8 5h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6" />
    <path d="M11 8h7v4h-7zM12 15h.01M16 15h.01M12 18h.01M16 18h.01" />
  </svg>;
  return <Icon aria-hidden="true" data-device-kind={kind || "web"} {...props} />;
}
