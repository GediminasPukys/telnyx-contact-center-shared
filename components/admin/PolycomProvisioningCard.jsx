"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useUiText } from "@/components/i18n/use-ui-text";

export default function PolycomProvisioningCard({ phone }) {
  const t = useUiText();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [currentAdminPassword, setCurrentAdminPassword] = useState("");
  const endpoint = `/api/admin/phones-provisioning/phones/${phone.id}/provision`;
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error("Unable to load provisioning status");
      setStatus(await response.json());
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [endpoint]);
  useEffect(() => {
    const timer = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function run(operation) {
    setBusy(operation); setError(""); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation,
        ...(operation === "configure" && currentAdminPassword ? { currentAdminPassword } : {}) }) });
      if (operation === "bootstrap" && response.ok) {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a"); link.href = url; link.download = `${phone.mac}-cc-bootstrap.cfg`; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("Import this private file in the phone's configuration utility, then restart the phone. It contains a device provisioning credential.");
      } else {
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.reason === "rest_api_disabled"
          ? "Enable the phone REST API using the bootstrap file before configuring it remotely."
          : result.reason || result.error || "Provisioning failed");
        setMessage(result.verified ? "Configuration verified on the phone. SIP line 1 is registered."
          : operation === "configure" ? "Configuration requested. Wait for the phone to restart or reload, then verify."
          : "Verification is pending. Check the provisioning username and password in the phone panel, its HTTPS certificate trust, configuration download and SIP line 1 registration.");
      }
      await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(""); setCurrentAdminPassword(""); }
  }

  return <section className="space-y-3 rounded-xl border p-4" data-testid="polycom-provisioning">
    <h3 className="text-sm font-semibold">{t("Direct HTTPS provisioning")}</h3>
    <p className="text-xs text-muted-foreground">{t("The phone downloads configuration from CC. A local bridge is optional. Remote CTI requires network access from CC to the phone.")}</p>
    {loading ? <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
      : status ? <div className="space-y-1 text-xs">
        <p>{t(status.verifiedAt ? "Verified on device" : status.downloadedAt ? "Downloaded; verification pending" : status.enrolled ? "Enrolled; waiting for configuration download" : "Not enrolled")}</p>
        {status.baseUrl ? <p className="break-all font-mono">{status.baseUrl}/api/provisioning/</p> : null}
        {status.verification?.firmware ? <p>{status.verification.model} · {status.verification.firmware}</p> : null}
      </div> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{t(error)}</p> : null}
    {message ? <p role="status" className="text-xs">{t(message)}</p> : null}
    {phone.vendor === "yealink" ? <label className="block space-y-1 text-xs">
      <span>{t("Current phone admin password (optional)")}</span>
      <Input type="password" autoComplete="new-password" value={currentAdminPassword} onChange={event => setCurrentAdminPassword(event.target.value)} />
      <span className="block text-muted-foreground">{t("Use for initial setup if the phone still has a different password. The saved administrator password is applied by provisioning.")}</span>
    </label> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => run("bootstrap")}>{t("Download bootstrap")}</Button>
      <Button size="sm" disabled={Boolean(busy)} onClick={() => run("configure")}>{t(busy === "configure" ? "Configuring…" : "Configure phone")}</Button>
      <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => run("verify")}>{t("Verify on phone")}</Button>
    </div>
  </section>;
}
