"use client";
import Image from "next/image";
import { cn } from "@/lib/utils";
const vendors = {
  polycom: { name:"Polycom", tone:"bg-sky-500", image:"polycom" },
  yealink: { name:"Yealink", tone:"bg-emerald-500", image:"yealink" },
  audiocodes: { name:"AudioCodes", tone:"bg-violet-500", image:"audiocodes" },
};
export default function PhoneVendorBadge({ vendor, count, compact = false, className }) {
  const brand = vendors[String(vendor || "").toLowerCase()];
  return <span title={brand?.name || vendor} aria-label={`${brand?.name || vendor}${count != null ? `: ${count}` : ""}`} data-testid="phone-vendor-badge"
    className={cn("inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2",compact ? "h-6" : "h-8",className)}>
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full",brand?.tone || "bg-muted-foreground")} />
    {brand ? <Image unoptimized src={`/images/hardphones/logos/${brand.image}.jpg`} alt={brand.name} width={80} height={24} className={cn("object-contain grayscale mix-blend-multiply dark:invert dark:mix-blend-screen",compact ? "h-3.5 w-16" : "h-5 w-20")} /> : <span className="text-xs font-medium">{vendor}</span>}
    {count != null ? <span className="ml-1 border-l pl-2 text-xs font-semibold tabular-nums">{count}</span> : null}
  </span>;
}
