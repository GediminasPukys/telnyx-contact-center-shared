"use client";
import { useEffect, useState } from "react";
export function useHeadsetAccess() {
  const [access, setAccess] = useState({ enabled: false, vendors: [], loading: true });
  useEffect(() => {
    let stopped = false, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try {
        const response = await fetch("/api/user/headsets", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error("Headset access could not be verified.");
        const value = await response.json(); if (!stopped) setAccess({ ...value, loading: false });
      } catch { if (!stopped) setAccess({ enabled: false, vendors: [], loading: false }); }
      finally { pending = false; }
    };
    refresh(); const timer = setInterval(refresh, 15000);
    window.addEventListener("experimental-features:refresh", refresh); window.addEventListener("focus", refresh);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("experimental-features:refresh", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  return access;
}
