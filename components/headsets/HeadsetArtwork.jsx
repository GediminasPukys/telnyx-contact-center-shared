"use client";

import { useState } from "react";
import Image from "next/image";
import { Headphones, Usb } from "lucide-react";
import { findHeadsetCatalogEntry } from "@/lib/headsets/headset-device-catalog";

/** Decorative artwork: the adjacent device name remains the accessible label. */
export function HeadsetArtwork({ device, className = "" }) {
  const entry = findHeadsetCatalogEntry(device);
  const [failedId, setFailedId] = useState(null);
  const showImage = entry?.images && failedId !== entry.id;
  const Fallback = entry?.role === "dongle" || device?.deviceRole === "dongle" ? Usb : Headphones;
  return <span aria-hidden="true" data-headset-artwork={entry?.id || "generic"}
    className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-black/5 bg-zinc-100 dark:border-white/10 dark:bg-zinc-700 ${className}`}>
    {showImage ? <>
      <Image src={entry.images.light} width={320} height={320} alt="" unoptimized onError={() => setFailedId(entry.id)}
        className="h-full w-full object-contain p-1.5 dark:hidden" />
      <Image src={entry.images.dark} width={320} height={320} alt="" unoptimized onError={() => setFailedId(entry.id)}
        className="hidden h-full w-full object-contain p-1.5 dark:block" />
    </> : <Fallback className="h-1/2 w-1/2 text-slate-500 dark:text-slate-200" />}
  </span>;
}
