"use client";
import { useState } from "react";
import Image from "next/image";
import { IconDeviceDesktop, IconDeviceLandlinePhone, IconDeviceMobile } from "@tabler/icons-react";
import { modelCatalogEntry } from "@/lib/hardphones/model-catalog.mjs";
export default function StationArtwork({ station, className = "", size = "thumbnail" }) {
  const [failedSource,setFailedSource] = useState(null);
  const entry = modelCatalogEntry(station.vendor, station.model);
  const src = entry?.[size === "preview" ? "preview" : "thumbnail"];
  const Icon = station.kind === "webrtc" ? IconDeviceDesktop : station.kind === "sip" ? IconDeviceMobile : IconDeviceLandlinePhone;
  return <div className={`flex items-center justify-center overflow-hidden rounded-xl bg-muted/30 ${className}`} data-phone-artwork={entry?.model || station.kind}>
    {src && failedSource !== src ? <Image unoptimized width={size === "preview" ? 640 : 160} height={size === "preview" ? 480 : 160} src={src} alt={station.model || station.name || ""} onError={()=>setFailedSource(src)} className="h-full w-full object-contain p-1.5"/> : <Icon size={70} stroke={1.25} className="max-h-full max-w-full p-1 text-primary/75" aria-label={station.model || station.name}/>}
  </div>;
}
