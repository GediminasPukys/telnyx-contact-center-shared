"use client";
import OutboundNumberSelect from "@/components/queues/OutboundNumberSelect";
import { operationalStatusLabel } from "@/lib/i18n/interaction-labels.mjs";
import { sourceText } from "@/lib/i18n/source-text.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";
import PolycomProvisioningCard from "@/components/admin/PolycomProvisioningCard";
import ExtensionAssignment from "@/components/telephony/ExtensionAssignment";


import PhoneVendorBadge from "@/components/telephony/PhoneVendorBadge";
import StationArtwork from "@/components/telephony/StationArtwork";
import { VENDOR_MODELS, modelCatalogEntry } from "@/lib/hardphones/model-catalog.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { notify } from "@/components/ToastNotify";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { SystemSectionPage } from "@/components/admin/SystemSectionNav";
import { useExperimentalFeatures } from "@/lib/experimental-features-client";
import { RAW_LOG_VIEWER_AVAILABLE } from "@/lib/deployment-capabilities.mjs";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconActivity,
  IconClockHour4,
  IconCopy,
  IconDeviceFloppy,
  IconDeviceLandlinePhone,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconExternalLink,
  IconLoader2,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneCall,
  IconPhoneIncoming,
  IconPhoneOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconPower,
  IconRefresh,
  IconRouteAltLeft,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";

const API = "/api/admin/phones-provisioning";
const HARDPHONE_RINGTONE_URL = "/audio/ringtone.mp3";

const NAV_ITEMS = [
  { id: "phones", label: "Phones", icon: IconDeviceLandlinePhone, description: "Hard phone inventory and per-device config" },
  { id: "bridges", label: "Bridges", icon: IconRouteAltLeft, description: "Local LAN bridge agents and connection status" },
  { id: "logs", label: "Logs", icon: IconDownload, description: "Provisioning event log with raw details" },
  { id: "settings", label: "Settings", icon: IconSettings, description: "Provisioning endpoint and vendor setup" },
].filter((item) => RAW_LOG_VIEWER_AVAILABLE || item.id !== "logs");

const SECTION_STORAGE_KEY = "admin.phones-provisioning.activeSection";

const VENDORS = [
  { value: "polycom", label: "Polycom / Poly" },
  { value: "yealink", label: "Yealink" },
  { value: "audiocodes", label: "AudioCodes" },
];

const toneClasses = { emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300", blue: "bg-sky-500/10 text-sky-600 dark:text-sky-300", violet: "bg-violet-500/10 text-violet-600 dark:text-violet-300", amber: "bg-amber-500/10 text-amber-600 dark:text-amber-300", rose: "bg-rose-500/10 text-rose-600 dark:text-rose-300" };
const neutralActionClass = "bg-zinc-950 text-white shadow-sm hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200";

const PHONE_TIMEZONES = [
  { value: "UTC", label: "UTC · GMT+00:00" },
  { value: "Europe/London", label: "London · GMT+00:00/+01:00" },
  { value: "Europe/Warsaw", label: "Warsaw · GMT+01:00/+02:00" },
  { value: "Europe/Berlin", label: "Berlin · GMT+01:00/+02:00" },
  { value: "Europe/Paris", label: "Paris · GMT+01:00/+02:00" },
  { value: "America/New_York", label: "New York · GMT-05:00/-04:00" },
  { value: "America/Chicago", label: "Chicago · GMT-06:00/-05:00" },
  { value: "America/Denver", label: "Denver · GMT-07:00/-06:00" },
  { value: "America/Los_Angeles", label: "Los Angeles · GMT-08:00/-07:00" },
  { value: "Asia/Dubai", label: "Dubai · GMT+04:00" },
  { value: "Asia/Singapore", label: "Singapore · GMT+08:00" },
  { value: "Asia/Tokyo", label: "Tokyo · GMT+09:00" },
  { value: "Australia/Sydney", label: "Sydney · GMT+10:00/+11:00" },
];

const stateBadgeClass = (state) => {
  const value = String(state || "").toLowerCase();
  if (value === "provisioned") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "pending") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (value === "disabled") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

const registrationBadgeClass = (state) => {
  const value = String(state || "unknown").toLowerCase();
  if (value === "registered") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "not_registered" || value === "unregistered") return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

function registrationBadgeLabel(state) {
  const value = String(state || "unknown").toLowerCase();
  if (value === "registered") return "Registered";
  if (value === "not_registered" || value === "unregistered") return "Not registered";
  return "Unknown";
}

const vendorBadgeClass = (vendor) => {
  const value = String(vendor || "").toLowerCase();
  if (value === "polycom") return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (value === "yealink") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (value === "audiocodes") return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
};

function vendorLabel(vendor, tUi = sourceText) {
  return VENDORS.find((x) => x.value === vendor)?.label || vendor || tUi("Unknown vendor");
}

function PhoneModelThumbnail({ vendor, model, className = "" }) {
  return <StationArtwork station={{ vendor, model, kind: "deskphone" }} className={`h-16 w-16 shrink-0 border border-border/60 [&_img]:p-1 [&_svg]:size-7 ${className}`} />;
}

function VendorLogoBadge({ vendor, count }) {
  return <PhoneVendorBadge vendor={vendor} count={count} />;
}

function formatMacDisplay(mac) {
  const value = String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (value.length !== 12) return mac || "—";
  return value.match(/.{2}/g).join(":");
}

function formatMacInput(mac) {
  const value = String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 12);
  return value.match(/.{1,2}/g)?.join(":") || "";
}

function formatTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString(); } catch { return "—"; }
}

function PanelHeader({ title, description }) {
  return (
    <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function SettingCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="rounded-2xl border bg-background/85 p-4 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="rounded-xl bg-sky-500/10 p-2 text-sky-600">
          <Icon className="h-4 w-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function MiniStat({ label, value, icon: Icon, tone = "blue" }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 truncate text-sm font-semibold">{value}</div>
        </div>
        {Icon ? (
          <span className={`shrink-0 rounded-lg p-1.5 ${toneClasses[tone] || toneClasses.blue}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Empty({ title, description }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center">
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function defaultPhoneSettings(userTimezone = "UTC") {
  return {
    cti_mode: "direct",
    line_keys: "1",
    timezone_discovery: true,
    ntp_timezone: PHONE_TIMEZONES.some((tz) => tz.value === userTimezone) ? userTimezone : "UTC",
    sntp_server: "pool.ntp.org",
    dynamic_reload: true,
    automatic_firmware_updates: true,
    firmware_source: "vendor-default",
    custom_config_url: "",
    syslog_server: "",
  };
}

const emptyPhoneDraft = (userTimezone = "UTC") => ({
  mac: "",
  vendor: "polycom",
  model: "",
  phone_name: "",
  label: "",
  assigned_phone_number_id: "",
  assigned_phone_number: "",
  ip_address: "",
  local_bridge_id: "",
  settings: defaultPhoneSettings(userTimezone),
});

function normalizePhoneSettings(raw = {}, userTimezone = "UTC") {
  return {
    ...defaultPhoneSettings(userTimezone),
    ...(raw && typeof raw === "object" ? raw : {}),
    timezone_discovery: raw?.timezone_discovery !== false,
    dynamic_reload: raw?.dynamic_reload !== false,
    automatic_firmware_updates: raw?.automatic_firmware_updates !== false,
  };
}

function phoneDraftValid(draft) {
  const mac = String(draft.mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return mac.length === 12 && VENDORS.some((v) => v.value === draft.vendor);
}

export default function PhonesProvisioningPage() {
  const tUi = useUiText();
  const router = useRouter();
  const {
    enabled: experimentalFeaturesEnabled,
    loading: experimentalFeaturesLoading,
  } = useExperimentalFeatures();
  const [active, setActive] = useState("phones");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const editorRef = useRef(null);
  const layoutRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [phones, setPhones] = useState([]);
  const [availablePhoneNumbers, setAvailablePhoneNumbers] = useState([]);
  const [hardphoneConfig, setHardphoneConfig] = useState({ phoneAdminPasswordConfigured: false, outboundVoiceProfileConfigured: false, userTimezone: "UTC" });
  const [bridges, setBridges] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [logsData, setLogsData] = useState({ events: [], total: 0, page: 1, pageSize: 10, days: 1, totalPages: 1 });
  const [logDays, setLogDays] = useState(1);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);
  const [logsLoading, setLogsLoading] = useState(false);
  const [phonesLoadSucceeded, setPhonesLoadSucceeded] = useState(false);
  const [selectedPhoneId, setSelectedPhoneId] = useState(null);
  const [selectedBridgeId, setSelectedBridgeId] = useState(null);
  const [selectedRebootIds, setSelectedRebootIds] = useState([]);
  const [pendingRebootIds, setPendingRebootIds] = useState([]);
  const [pendingRebootHostOverrides, setPendingRebootHostOverrides] = useState({});
  const [rebooting, setRebooting] = useState(false);
  // Custom confirm dialog for phone delete (no native window.confirm — project convention).
  const [confirmDeletePhone, setConfirmDeletePhone] = useState(null);
  const [phoneDraft, setPhoneDraft] = useState(emptyPhoneDraft());

  const activeMeta = useMemo(() => NAV_ITEMS.find((i) => i.id === active) || NAV_ITEMS[0], [active]);
  const selectedPhone = useMemo(() => phones.find((p) => p.id === selectedPhoneId) || null, [phones, selectedPhoneId]);
  const selectedBridge = useMemo(() => bridges.find((b) => b.bridge_id === selectedBridgeId) || null, [bridges, selectedBridgeId]);
  const pendingRebootPhones = useMemo(() => phones.filter((p) => pendingRebootIds.includes(p.id)), [phones, pendingRebootIds]);
  const pendingRebootLabel = pendingRebootIds.length === phones.length ? tUi("all phones") : tUi("selected phones: {value0}", { value0: pendingRebootIds.length });

  useEffect(() => {
    if (!experimentalFeaturesLoading && !experimentalFeaturesEnabled) {
      router.replace("/admin/system");
    }
  }, [experimentalFeaturesEnabled, experimentalFeaturesLoading, router]);

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("section");
      if (requested && NAV_ITEMS.some((i) => i.id === requested)) { setActive(requested); return; }
      const saved = localStorage.getItem(SECTION_STORAGE_KEY);
      if (saved && NAV_ITEMS.some((i) => i.id === saved)) setActive(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, active);
      const url = new URL(window.location.href);
      if (url.searchParams.get("section") !== active) {
        url.searchParams.set("section", active);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
  }, [active]);

  const refresh = useCallback(async (toast = false, options = {}) => {
    if (!experimentalFeaturesEnabled) {
      if (!options.silent) setLoading(false);
      return;
    }
    if (!options.silent) setLoading(true);
    try {
      const includeAvailablePhoneNumbers = options.includeAvailablePhoneNumbers || (active === "phones" && !options.silent);
      const [phonesRes, dashboardRes, bridgesRes] = await Promise.all([
        fetch(`${API}/phones${includeAvailablePhoneNumbers ? "?includeAvailablePhoneNumbers=1" : ""}`),
        fetch(`${API}/dashboard`),
        fetch(`${API}/bridges`),
      ]);
      if (!phonesRes.ok || !dashboardRes.ok || !bridgesRes.ok) throw new Error("Failed to load phones provisioning");
      setLoadError("");
      const phonesData = phonesRes.ok ? await phonesRes.json() : null;
      const dashboardData = dashboardRes.ok ? await dashboardRes.json() : null;
      const bridgesData = bridgesRes.ok ? await bridgesRes.json() : { bridges: [] };
      if (phonesData) {
        setPhones(phonesData.phones || []);
        if (includeAvailablePhoneNumbers) setAvailablePhoneNumbers(phonesData.availablePhoneNumbers || []);
        setHardphoneConfig({ phoneAdminPasswordConfigured: false, outboundVoiceProfileConfigured: false, userTimezone: "UTC", ...(phonesData.config || {}) });
        setPhonesLoadSucceeded(true);
      } else {
        setPhonesLoadSucceeded(false);
      }
      setDashboard(dashboardData);
      setBridges(bridgesData.bridges || []);
      if (toast) notify({ title: "Phones provisioning refreshed", description: "Data reloaded.", variant: "success" });
    } catch (err) {
      setLoadError(err.message);
      notify({ title: "Failed to load phones provisioning", description: err.message, variant: "error" });
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [active, experimentalFeaturesEnabled]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectedPhoneId || loading || !phonesLoadSucceeded) return;
    if (!phones.some((phone) => phone.id === selectedPhoneId)) setSelectedPhoneId(null);
  }, [loading, phones, phonesLoadSucceeded, selectedPhoneId]);

  useEffect(() => {
    if (active !== "bridges" && active !== "phones") return undefined;
    const timer = setInterval(() => refresh(false, { silent: true, includeAvailablePhoneNumbers: false }), 10000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    if (selectedPhone) {
      setPhoneDraft({
        mac: selectedPhone.mac || "",
        vendor: selectedPhone.vendor || "polycom",
        model: selectedPhone.model || "",
        phone_name: selectedPhone.phone_name || "",
        label: selectedPhone.label || selectedPhone.extension || "",
        assigned_phone_number_id: selectedPhone.assigned_phone_number_id || "",
        assigned_phone_number: selectedPhone.assigned_phone_number || "",
        ip_address: selectedPhone.last_ip || selectedPhone.ip_address || "",
        local_bridge_id: selectedPhone.local_bridge_id || selectedPhone.settings?.local_bridge_id || "",
        settings: normalizePhoneSettings(selectedPhone.settings, hardphoneConfig.userTimezone),
      });
    } else {
      setPhoneDraft(emptyPhoneDraft(hardphoneConfig.userTimezone));
    }
    // Deliberately key this to selection changes only. The 10s status refresh replaces
    // selectedPhone with a fresh object from the server; resetting the draft on every
    // refresh would wipe unsaved edits in Context Settings before the admin can save.
  }, [selectedPhoneId, hardphoneConfig.userTimezone]);

  function selectPhone(id) {
    setSelectedPhoneId(id);
    if (window.matchMedia("(min-width: 1280px)").matches) editorRef.current?.scrollTo({ top: 0 });
    else if (editorRef.current && layoutRef.current) {
      const container = layoutRef.current;
      container.scrollTo({ top: editorRef.current.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop, behavior: "smooth" });
    }
  }

  const draftValid = phoneDraftValid(phoneDraft);

  const loadLogs = useCallback(async (overrides = {}) => {
    if (!RAW_LOG_VIEWER_AVAILABLE || !experimentalFeaturesEnabled) return;
    const nextDays = overrides.days ?? logDays;
    const nextPage = overrides.page ?? logPage;
    const nextPageSize = overrides.pageSize ?? logPageSize;
    setLogsLoading(true);
    try {
      const params = new URLSearchParams({ days: String(nextDays), page: String(nextPage), pageSize: String(nextPageSize) });
      const res = await fetch(`${API}/logs?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load provisioning logs");
      setLogsData(data);
    } catch (err) {
      notify({ title: "Failed to load provisioning logs", description: err.message, variant: "error" });
    } finally {
      setLogsLoading(false);
    }
  }, [experimentalFeaturesEnabled, logDays, logPage, logPageSize]);

  useEffect(() => {
    if (active === "logs") loadLogs();
  }, [active, loadLogs]);

  async function savePhone() {
    if (!draftValid) return;
    setSaving(true);
    try {
      const payload = {
        mac: phoneDraft.mac,
        vendor: phoneDraft.vendor,
        model: phoneDraft.model.trim(),
        phone_name: phoneDraft.phone_name.trim(),
        label: phoneDraft.label.trim() === selectedPhone?.extension ? "" : phoneDraft.label.trim(),
        assigned_phone_number_id: phoneDraft.assigned_phone_number_id || "",
        assigned_phone_number: phoneDraft.assigned_phone_number || "",
        local_bridge_id: phoneDraft.local_bridge_id.trim(),
        settings: normalizePhoneSettings({ ...phoneDraft.settings, local_bridge_id: phoneDraft.local_bridge_id.trim() }, hardphoneConfig.userTimezone),
      };
      const url = selectedPhone ? `${API}/phones/${selectedPhone.id}` : `${API}/phones`;
      const res = await fetch(url, {
        method: selectedPhone ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      const data = await res.json();
      notify({ title: selectedPhone ? "Phone updated" : "Phone added", description: data.displaySync?.ok === false ? tUi("Settings saved. The display label will update when the phone next provisions.") : formatMacDisplay(data.phone?.mac), variant: "success" });
      setPhones((prev) => (selectedPhone ? prev.map((p) => (p.id === selectedPhone.id ? { ...p, ...data.phone } : p)) : [data.phone, ...prev]));
      setPhoneDraft(d => d.label === phoneDraft.label
        ? {...d,label:data.phone?.label || data.phone?.extension || selectedPhone?.extension || ""}
        : d);
      if (!selectedPhone && data.phone?.id) setSelectedPhoneId(data.phone.id);
    } catch (err) {
      notify({ title: "Save failed", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  // Open the custom confirm dialog (project convention: no native window.confirm).
  function deletePhone(item) {
    setConfirmDeletePhone(item);
  }

  async function performDeletePhone(item) {
    if (!item) return;
    try {
      const res = await fetch(`${API}/phones/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      notify({ title: "Phone deleted", variant: "success" });
      setPhones((prev) => prev.filter((p) => p.id !== item.id));
      if (selectedPhoneId === item.id) setSelectedPhoneId(null);
    } catch (err) {
      notify({ title: "Delete failed", description: err.message, variant: "error" });
    }
  }

  async function togglePhoneState(item) {
    const next = item.provisioning_state === "disabled" ? "pending" : "disabled";
    try {
      const res = await fetch(`${API}/phones/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provisioning_state: next }),
      });
      if (!res.ok) throw new Error("Update failed");
      const data = await res.json();
      setPhones((prev) => prev.map((p) => (p.id === item.id ? { ...p, ...data.phone } : p)));
      notify({ title: next === "disabled" ? "Provisioning disabled" : "Provisioning re-enabled", description: formatMacDisplay(item.mac), variant: "success" });
    } catch (err) {
      notify({ title: "Update failed", description: err.message, variant: "error" });
    }
  }

  function requestRebootPhones(ids, options = {}) {
    const phoneIds = ids && ids.length ? ids : selectedRebootIds;
    if (!phoneIds.length) return;
    setPendingRebootIds(phoneIds);
    setPendingRebootHostOverrides(options.hostOverrides || {});
  }

  async function confirmRebootPhones() {
    const phoneIds = pendingRebootIds;
    const hostOverrides = pendingRebootHostOverrides;
    if (!phoneIds.length) return;
    setPendingRebootIds([]);
    setPendingRebootHostOverrides({});
    setRebooting(true);
    try {
      const res = await fetch(`${API}/phones/reboot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_ids: phoneIds, ...(Object.keys(hostOverrides).length ? { host_overrides: hostOverrides } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Remote reboot failed");
      const ok = (data.results || []).filter((r) => r.ok).length;
      notify({ title: "Remote reboot requested", description: tUi("{value0}/{value1} accepted", {value0: ok, value1: data.results?.length || phoneIds.length}), variant: ok ? "success" : "warning" });
      await refresh(false);
    } catch (err) {
      notify({ title: "Remote reboot failed", description: err.message, variant: "error" });
    } finally {
      setRebooting(false);
    }
  }

  const headerCreate = ["phones", "bridges"].includes(active);
  const totals = dashboard?.totals || { total: 0, provisioned: 0, pending: 0, disabled: 0, recently_seen: 0 };

  if (experimentalFeaturesLoading || !experimentalFeaturesEnabled) {
    return (
      <AdminPageShell>
        <AdminPageHeader title={tUi("Phones Provisioning")} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {experimentalFeaturesLoading ? tUi("Checking feature access…") : tUi("This experimental feature is not enabled for your account.")}
        </div>
      </AdminPageShell>
    );
  }

  return (
    <AdminPageShell>
      <AdminPageHeader
        title={tUi("Phones Provisioning")}
        badges={(
          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            {loading && !dashboard ? <Skeleton className="h-4 w-12" /> : <>{totals.total}{tUi(" phones")}</>}</Badge>
        )}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => (active === "logs" ? loadLogs() : refresh(true))} disabled={loading || logsLoading}>
              <IconRefresh className={`mr-2 h-4 w-4 ${loading || logsLoading ? "animate-spin" : ""}`} />{tUi("Refresh")}</Button>
            {headerCreate ? (
              <Button size="sm" className={neutralActionClass} onClick={() => { if (active === "phones") { selectPhone(null);setPhoneDraft(emptyPhoneDraft(hardphoneConfig.userTimezone)); } else setSelectedBridgeId(null); }} disabled={saving}>
                <IconWand className="mr-2 h-4 w-4" />
                {active === "phones" ? tUi("New phone") : tUi("New bridge")}
              </Button>
            ) : null}
          </>
        )}
      />
      <SystemSectionPage activeId="phones-provisioning">
      <div ref={layoutRef} className="grid min-h-0 flex-1 gap-4 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_380px] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <section className="flex h-[min(760px,75svh)] min-h-80 min-w-0 flex-col overflow-hidden rounded-xl border bg-card xl:h-auto xl:min-h-0" data-testid="provisioning-list-card">
          <Tabs value={active} onValueChange={setActive} className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 px-4 pt-3">
              <TabsList aria-label={tUi("Phones provisioning sections")}>
                {NAV_ITEMS.map(item => <TabsTrigger key={item.id} value={item.id}><item.icon />{tUi(item.label)}</TabsTrigger>)}
              </TabsList>
            </div>
            {loadError ? <div role="alert" className="m-4 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{tUi(loadError)}<Button variant="outline" size="sm" onClick={() => refresh()}>{tUi("Retry")}</Button></div> : null}
            <TabsContent value={active} className={`min-h-0 ${active === "phones" ? "flex flex-col overflow-hidden" : "overflow-y-auto p-4"}`}>
            {loading && !phonesLoadSucceeded ? <div className="space-y-4 p-4" aria-busy="true"><Skeleton className="h-20 w-full" />{Array.from({ length: 5 },(_,i) => <Skeleton key={i} className="h-16 w-full" />)}</div> : !phonesLoadSucceeded ? null : <>
            {active === "phones" ? (
              <PhonesListView
                phones={phones}
                selectedPhoneId={selectedPhone?.id || null}
                selectedRebootIds={selectedRebootIds}
                setSelectedPhoneId={selectPhone}
                setSelectedRebootIds={setSelectedRebootIds}
                deletePhone={deletePhone}
                togglePhoneState={togglePhoneState}
                rebootPhones={requestRebootPhones}
                rebooting={rebooting}
              />
            ) : active === "bridges" ? (
              <BridgesListView bridges={bridges} phones={phones} selectedBridgeId={selectedBridge?.bridge_id || null} setSelectedBridgeId={setSelectedBridgeId} />
            ) : active === "logs" ? (
              <LogsView
                logs={logsData}
                days={logDays}
                page={logPage}
                pageSize={logPageSize}
                loading={logsLoading}
                setLogDays={(days) => { setLogDays(days); setLogPage(1); }}
                setLogPage={setLogPage}
                setLogPageSize={(pageSize) => { setLogPageSize(pageSize); setLogPage(1); }}
              />
            ) : (
              <SettingsSummaryView />
            )}
            </>}
            </TabsContent>
          </Tabs>
        </section>

        {/* Right panel — Context Settings */}
        <aside className="flex h-[min(760px,75svh)] min-h-80 flex-col overflow-hidden rounded-xl border bg-card xl:h-auto xl:min-h-0" data-testid="provisioning-editor">
          <PanelHeader
            title={active === "phones" ? selectedPhone?.phone_name || selectedPhone?.label || tUi("New phone") : active === "logs" ? tUi("Log filters") : tUi("Context settings")}
            description={active === "logs" ? tUi("Range and page controls") : tUi("{value0} configuration", { value0: activeMeta.label })}
          />
          <div ref={editorRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4" data-testid="provisioning-editor-scroll">
            {loading && !phonesLoadSucceeded ? <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div> : loadError && !phonesLoadSucceeded ? null : active === "phones" ? (
              <PhoneEditor
                draft={phoneDraft}
                setDraft={setPhoneDraft}
                editing={Boolean(selectedPhone)}
                phone={selectedPhone}
                bridges={bridges}
                hardphoneConfig={hardphoneConfig}
                rebootPhones={requestRebootPhones}
                rebooting={rebooting}
                onExtensionSaved={({number,previousNumber}) => {
                  setPhoneDraft(d => !d.label.trim() || d.label.trim() === previousNumber ? {...d,label:number} : d);
                  refresh(false, { silent: true });
                }}
              />
            ) : active === "bridges" ? (
              <BridgeEditor bridges={bridges} bridge={selectedBridge} phones={phones} refresh={refresh} onSelect={setSelectedBridgeId} />
            ) : active === "logs" ? (
              <LogsContext logs={logsData} days={logDays} pageSize={logPageSize} loading={logsLoading} onRefresh={() => loadLogs()} />
            ) : (
              <SettingsEditor bridges={bridges} refresh={refresh} />
            )}
          </div>
          {active === "phones" && (phonesLoadSucceeded || loading) ? (
            <div className="shrink-0 space-y-2 border-t bg-card p-4" data-testid="provisioning-editor-footer">
              {!phonesLoadSucceeded ? <Skeleton className="h-9 w-full" /> : (
                <>
                  <Button className="w-full" onClick={savePhone} disabled={!draftValid || saving || (!selectedPhone && (!hardphoneConfig.phoneAdminPasswordConfigured || !hardphoneConfig.outboundVoiceProfileConfigured))} data-testid="hp-save-phone">
                    {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}
                    {selectedPhone ? tUi("Save phone") : tUi("Add phone")}
                  </Button>
                  {!draftValid ? (
                    <p className="text-xs text-amber-600 dark:text-amber-300">{tUi("Required: a valid 12-hex-digit MAC address and a vendor.")}</p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </aside>
      </div>
      </SystemSectionPage>
      <AlertDialog open={Boolean(pendingRebootIds.length)} onOpenChange={(open) => { if (!open) { setPendingRebootIds([]); setPendingRebootHostOverrides({}); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tUi("Reboot hardphone")}{pendingRebootIds.length === 1 ? "" : tUi("s")}?</AlertDialogTitle>
            <AlertDialogDescription>{tUi("Send a remote reboot command to ")}{pendingRebootLabel}{tUi(". Active calls may be interrupted and the phone")}{pendingRebootIds.length === 1 ? "" : tUi("s")}{tUi(" can be unavailable while restarting.")}</AlertDialogDescription>
          </AlertDialogHeader>
          {pendingRebootPhones.length ? (
            <div className="max-h-40 overflow-y-auto rounded-lg border bg-muted/30 p-2 text-xs">
              {pendingRebootPhones.map((phone) => (
                <div key={phone.id} className="flex items-center justify-between gap-3 py-1">
                  <span className="truncate">{phone.phone_name || phone.label || phone.model || tUi("Hardphone")}</span>
                  <span className="text-muted-foreground">{pendingRebootHostOverrides[phone.id] || formatMacDisplay(phone.mac)}</span>
                </div>
              ))}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rebooting}>{tUi("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRebootPhones} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={rebooting}>
              {rebooting ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconPower className="mr-2 h-4 w-4" />}{tUi("Reboot")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Custom confirm: Delete phone (replaces native window.confirm) */}
      <AlertDialog open={confirmDeletePhone !== null} onOpenChange={(open) => { if (!open) setConfirmDeletePhone(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tUi("Delete phone?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeletePhone
                ? <>{tUi("This permanently deletes the phone ")}<span className="font-medium text-foreground">{formatMacDisplay(confirmDeletePhone.mac)}</span>{tUi(" and its Telnyx credential. This action cannot be undone.")}</>
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tUi("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { const item = confirmDeletePhone; setConfirmDeletePhone(null); performDeletePhone(item); }}
            >{tUi("Delete phone")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPageShell>
  );
}

function logDetailText(detail) {
  if (detail == null) return "{}";
  if (typeof detail === "string") return detail;
  try { return JSON.stringify(detail, null, 2); } catch { return String(detail); }
}

function LogsView({ logs, days, page, pageSize, loading, setLogDays, setLogPage, setLogPageSize }) {
  const tUi = useUiText();
  const events = logs?.events || [];
  const total = logs?.total || 0;
  const totalPages = Math.max(1, logs?.totalPages || Math.ceil(total / pageSize) || 1);

  return (
    <div className="space-y-4">
      <SettingCard icon={IconDownload} title={tUi("Provisioning logs")} subtitle={tUi("Phone config fetches, bridge observations, CTI commands, and vendor callbacks")}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{tUi("Range")}</Label>
              <Select value={String(days)} onValueChange={(value) => setLogDays(Number(value))}>
                <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{tUi("Last 1 day")}</SelectItem>
                  <SelectItem value="7">{tUi("Last 7 days")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{tUi("Items per page")}</Label>
              <Select value={String(pageSize)} onValueChange={(value) => setLogPageSize(Number(value))}>
                <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[10, 25, 50].map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {loading ? <Skeleton className="h-6 w-20" /> : <Badge variant="outline" className="bg-card">{total}{tUi(" event")}{total === 1 ? "" : tUi("s")}</Badge>}
        </div>
      </SettingCard>

      <SettingCard icon={IconActivity} title={tUi("Event list")} subtitle={tUi("Expand a row to inspect hp_provisioning_events.detail")}>
        {loading ? (
          <div className="space-y-3" aria-busy="true">{Array.from({length:5},(_,i)=><Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : events.length ? (
          <Accordion type="multiple" className="rounded-xl border">
            {events.map((event) => (
              <AccordionItem key={event.id} value={String(event.id)} className="px-3">
                <AccordionTrigger className="py-3 hover:no-underline">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 pr-3 text-left">
                    <Badge variant="outline" className="max-w-[220px] truncate bg-card" title={tUi("Phone name")}>{tUi("Phone name: ")}{event.phone_name || event.label || "—"}</Badge>
                    <Badge variant="outline" className="bg-card font-mono" title={tUi("MAC address")}>{tUi("MAC address: ")}{event.mac ? formatMacDisplay(event.mac) : "—"}</Badge>
                    <Badge variant="outline" className="bg-card font-mono" title={tUi("Event type")}>{tUi("Event type: ")}{event.event_type || "—"}</Badge>
                    <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{formatTime(event.created_at)}</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <pre className="max-h-96 overflow-auto rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">{logDetailText(event.detail)}</pre>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : (
          <Empty title={tUi("No provisioning logs")} description={tUi("No hardphone provisioning events exist for the selected range.")} />
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setLogPage(page - 1)}>{tUi("Previous")}</Button>
          <span className="text-sm text-muted-foreground">{tUi("Page ")}{page}{tUi(" of ")}{totalPages}</span>
          <Button variant="outline" size="sm" disabled={loading || page >= totalPages} onClick={() => setLogPage(page + 1)}>{tUi("Next")}</Button>
        </div>
      </SettingCard>
    </div>
  );
}

function LogsContext({ logs, days, pageSize, loading, onRefresh }) {
  const tUi = useUiText();
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-xl border bg-muted/30 p-4 text-muted-foreground">{tUi("Showing the last ")}{days}{tUi(" day")}{days === 1 ? "" : tUi("s")}, {pageSize}{tUi(" rows per page. Each log row opens the raw hp_provisioning_events.detail payload.")}</div>
      <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
        <IconRefresh className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />{tUi("Refresh logs")}</Button>
      <MiniStat label={tUi("Matching events")} value={logs?.total || 0} icon={IconActivity} tone="violet" />
    </div>
  );
}

function PhonesListView({ phones, selectedPhoneId, selectedRebootIds, setSelectedPhoneId, setSelectedRebootIds, deletePhone, togglePhoneState, rebootPhones, rebooting }) {
  const tUi = useUiText();
  const [search, setSearch] = useState("");
  const [vendor, setVendor] = useState("");
  const query = search.trim().toLowerCase();
  const visible = phones.filter(p => (!vendor || p.vendor === vendor) && (!query || [p.phone_name,p.label,p.mac,formatMacDisplay(p.mac),p.model,p.sip_username,p.extension,p.last_ip].some(v => String(v || "").toLowerCase().includes(query))));
  const allSelected = visible.length > 0 && visible.every(p => selectedRebootIds.includes(p.id));
  const toggleRebootSelection = id => setSelectedRebootIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev,id]);
  return <>
    <div className="shrink-0 space-y-3 p-4" data-testid="provisioning-filters">
      <div className="grid grid-cols-3 gap-2">
        {VENDORS.map(v => <button type="button" key={v.value} aria-pressed={vendor === v.value} onClick={() => setVendor(current => current === v.value ? "" : v.value)} className={`flex min-w-0 items-center gap-2 rounded-xl border bg-muted/20 p-3 text-left transition hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${vendor === v.value ? "border-foreground/40 ring-1 ring-foreground/20" : "border-border"}`}>
          <span className={`rounded-lg p-2 ${vendorBadgeClass(v.value)}`}><IconDeviceLandlinePhone className="size-4" /></span>
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{v.label}</p><p className="mt-0.5 text-lg font-semibold tabular-nums">{phones.filter(p => p.vendor === v.value).length}</p></div>
        </button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={tUi("Search name, model, MAC or extension")} aria-label={tUi("Search phones")} className="min-w-40 flex-1" />
        <Badge variant="outline" className="font-normal tabular-nums">{tUi("{value0} shown", { value0: visible.length })}</Badge>
        <Button size="sm" variant="outline" disabled={rebooting || !selectedRebootIds.length} onClick={() => rebootPhones(selectedRebootIds)} data-testid="hp-bulk-reboot-selected"><IconPower className="size-4" />{tUi("Reboot selected")}{selectedRebootIds.length ? ` (${selectedRebootIds.length})` : ""}</Button>
        <Button size="sm" variant="outline" disabled={rebooting || !phones.length} onClick={() => rebootPhones(phones.map(p => p.id))} data-testid="hp-bulk-reboot-all">{tUi("Reboot all")}</Button>
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="provisioning-phones-scroll">
      {!phones.length ? <div className="px-4 pb-4"><Empty title={tUi("No phones yet")} description={tUi("Use New phone in the header, fill in the MAC and vendor in Context Settings on the right, then save. A Telnyx SIP credential is created automatically.")} /></div> : !visible.length ? <div className="px-4 pb-4"><Empty title={tUi("No matching phones")} description={tUi("Try another name, model or number.")} /></div> : <table className="w-full min-w-[800px] text-left text-sm">
        <thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground"><tr className="border-y">
          <th className="w-10 py-3 pl-4"><input type="checkbox" checked={allSelected} onChange={() => setSelectedRebootIds(prev => allSelected ? prev.filter(id => !visible.some(p => p.id === id)) : [...new Set([...prev,...visible.map(p => p.id)])])} aria-label={tUi("Select all phones for reboot")} /></th>
          <th className="px-2 py-3 font-medium">{tUi("Phone")}</th><th className="px-2 font-medium">{tUi("Extension")}</th><th className="px-2 font-medium">{tUi("DID")}</th><th className="px-2 font-medium">{tUi("State")}</th><th className="px-2 font-medium">{tUi("Last seen")}</th><th className="pr-4 text-right font-medium">{tUi("Actions")}</th>
        </tr></thead>
        <tbody>{visible.map(p => <tr key={p.id} data-phone-id={p.id} data-selected={selectedPhoneId === p.id} onClick={() => setSelectedPhoneId(p.id)} className={`cursor-pointer border-b transition hover:bg-muted/40 ${selectedPhoneId === p.id ? "bg-muted/60" : ""}`}>
          <td className="py-3 pl-4" onClick={e => e.stopPropagation()}><input type="checkbox" checked={selectedRebootIds.includes(p.id)} onChange={() => toggleRebootSelection(p.id)} aria-label={tUi("Select {value0} for reboot", { value0: formatMacDisplay(p.mac) })} /></td>
          <td className="max-w-72 px-2 py-3"><button type="button" className="flex w-full items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={e => {e.stopPropagation();setSelectedPhoneId(p.id);}} aria-pressed={selectedPhoneId === p.id}>
            <PhoneModelThumbnail vendor={p.vendor} model={p.model} /><span className="min-w-0"><span className="block truncate font-semibold">{p.phone_name || p.label || formatMacDisplay(p.mac)}</span><span className="mt-1 flex flex-wrap gap-1"><PhoneVendorBadge vendor={p.vendor} compact />{p.model ? <Badge variant="outline" className={`text-[10px] ${vendorBadgeClass(p.vendor)}`}>{p.model}</Badge> : null}</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">{formatMacDisplay(p.mac)}</span></span>
          </button></td>
          <td data-testid="phone-extension" className="px-2 font-mono text-xs">{p.extension ? <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 font-mono text-sky-700 dark:text-sky-300">{p.extension}</Badge> : null}</td>
          <td data-testid="phone-did" className="whitespace-nowrap px-2 font-mono text-xs tabular-nums">{p.assigned_phone_number || ""}</td>
          <td className="px-2"><div className="flex flex-col items-start gap-1"><Badge variant="outline" className={stateBadgeClass(p.provisioning_state)}>{p.provisioning_state}</Badge><Badge variant="outline" className={registrationBadgeClass(p.sip_registration_status)}>{tUi(registrationBadgeLabel(p.sip_registration_status))}</Badge></div></td>
          <td className="px-2 text-xs text-muted-foreground">{p.last_seen_at ? formatTime(p.last_seen_at) : tUi("never")}</td>
          <td className="pr-3"><div className="flex justify-end gap-0.5">
            <Button size="icon" variant="ghost" className="size-7" aria-label={tUi("Remote reboot")} title={tUi("Remote reboot")} disabled={rebooting} onClick={e => {e.stopPropagation();rebootPhones([p.id]);}}><IconPower className="size-3.5" /></Button>
            <Button size="icon" variant="ghost" className="size-7" aria-label={p.provisioning_state === "disabled" ? tUi("Enable provisioning") : tUi("Disable provisioning")} title={p.provisioning_state === "disabled" ? tUi("Enable provisioning") : tUi("Disable provisioning")} onClick={e => {e.stopPropagation();togglePhoneState(p);}}>{p.provisioning_state === "disabled" ? <IconEye className="size-3.5" /> : <IconEyeOff className="size-3.5" />}</Button>
            <Button size="icon" variant="ghost" className="size-7 text-destructive" aria-label={tUi("Delete")} title={tUi("Delete")} onClick={e => {e.stopPropagation();deletePhone(p);}}><IconTrash className="size-3.5" /></Button>
          </div></td>
        </tr>)}</tbody>
      </table>}
    </div>
  </>;
}

function PhoneEditor({ draft, setDraft, editing, phone, bridges = [], hardphoneConfig = {}, rebootPhones, rebooting = false, onExtensionSaved }) {
  const tUi = useUiText();
  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const phoneAdminPasswordConfigured = hardphoneConfig.phoneAdminPasswordConfigured === true;
  const outboundVoiceProfileConfigured = hardphoneConfig.outboundVoiceProfileConfigured === true;
  const updateSettings = (patch) => setDraft((d) => ({ ...d, settings: normalizePhoneSettings({ ...(d.settings || {}), ...patch }, hardphoneConfig.userTimezone) }));
  const models = VENDOR_MODELS[draft.vendor] || [];
  const catalogEntry = modelCatalogEntry(draft.vendor, draft.model);

  return (
    <>
      <SettingCard icon={IconDeviceLandlinePhone} title={editing ? tUi("Edit phone") : tUi("New phone")}>
        <div className="space-y-3">
          <div>
            <Label>{tUi("Phone Name")}</Label>
            <Input className="mt-1" value={draft.phone_name} onChange={(e) => update({ phone_name: e.target.value })} placeholder={tUi("Desk phone / Reception")} />
          </div>
          <div>
            <Label>{tUi("MAC address")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
            <Input className="mt-1 font-mono" value={formatMacInput(draft.mac)} onChange={(e) => update({ mac: formatMacInput(e.target.value) })} placeholder={tUi("00:90:8f:00:00:01")} disabled={editing} />
          </div>
          <div>
            <Label>{tUi("Vendor")}<span aria-hidden="true" className="ml-1 text-red-500">*</span></Label>
            <Select value={draft.vendor} onValueChange={(v) => update({ vendor: v, model: "" })}>
              <SelectTrigger className="mt-1 w-full"><SelectValue placeholder={tUi("Vendor")} /></SelectTrigger>
              <SelectContent>
                {VENDORS.map((v) => <SelectItem key={v.value} value={v.value}>{tUi(v.label)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{tUi("Model")}</Label>
            <Select value={draft.model || ""} onValueChange={(v) => update({ model: v })}>
              <SelectTrigger className="mt-1 w-full"><SelectValue placeholder={tUi("Select model")} /></SelectTrigger>
              <SelectContent>
                {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {catalogEntry ? <PhoneModelPreview vendor={draft.vendor} model={draft.model} catalogEntry={catalogEntry} /> : null}
          <PhoneModelSettingsCard vendor={draft.vendor} model={draft.model} settings={normalizePhoneSettings(draft.settings)} updateSettings={updateSettings} draft={draft} update={update} bridges={bridges} />
          <div>
            <Label>{tUi("Line Label")}</Label>
            <Input className="mt-1" id="phone-line-label" maxLength={draft.vendor === "yealink" ? 99 : 256} value={draft.label} onChange={(e) => update({ label: e.target.value })} placeholder={phone?.extension || tUi("Line 1 / Agent name")} />
            <p className="mt-1.5 text-xs text-muted-foreground">{tUi("Defaults to the assigned extension. Enter a custom name to show it on the phone display instead; clear it to restore the extension.")}</p>
          </div>
          <div className="rounded-xl border bg-muted/20 p-3">
            <OutboundNumberSelect id="hp-phone-number-select" endpoint="/api/admin/phones-provisioning/number-options"
              label={tUi("Telnyx number")} value={draft.assigned_phone_number_id} number={draft.assigned_phone_number}
              onChange={(id, number) => update({ assigned_phone_number_id: id, assigned_phone_number: number })}
              description={tUi("Used for calls from this phone when no user is signed in. Signed-in users choose their own caller ID. Without a phone DID, the system Main From Number is used.")} />
          </div>
          {phoneAdminPasswordConfigured && outboundVoiceProfileConfigured ? null : (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span>{tUi("Configure ")}{phoneAdminPasswordConfigured ? tUi("TELNYX_OUTBOUND_VOICE_PROFILE") : tUi("TELNYX_PHONE_ADMIN_PASSWORD")}{!phoneAdminPasswordConfigured && !outboundVoiceProfileConfigured ? tUi(" and TELNYX_OUTBOUND_VOICE_PROFILE") : ""}{tUi(" before adding new hard phones.")}</span>
            </div>
          )}
          <div>
            <Label>{tUi("Detected phone IP address")}</Label>
            <Input className="mt-1 font-mono" value={editing ? (phone.last_ip || phone.ip_address || "") : "Auto-detected after first phone callback"} readOnly placeholder={tUi("Waiting for provisioning/event callback")} />
          </div>
        </div>
      </SettingCard>

      {editing && phone ? (
        <SettingCard icon={IconPhoneCall} title={tUi("SIP registration")}>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("SIP username")}</span>
              <span className="truncate font-mono text-xs">{phone.sip_username || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("SIP connection ID")}</span>
              <span className="truncate font-mono text-xs">{phone.telnyx_connection_id || phone.telnyx_credential_id || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("Assigned number")}</span>
              <span className="truncate font-mono text-xs">{phone.assigned_phone_number || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("SIP server")}</span>
              <span className="font-mono text-xs">{tUi("sip.telnyx.com")}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("Telnyx registration")}</span>
              <Badge variant="outline" className={registrationBadgeClass(phone.sip_registration_status)}>{tUi(registrationBadgeLabel(phone.sip_registration_status))}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("State")}</span>
              <Badge variant="outline" className={stateBadgeClass(phone.provisioning_state)}>{phone.provisioning_state}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{tUi("Last user agent")}</span>
              <span className="truncate text-xs">{phone.last_user_agent || "—"}</span>
            </div>
            <PhoneMaintenanceActions phone={phone} rebootPhones={rebootPhones} rebooting={rebooting} />
          </div>
        </SettingCard>
      ) : null}

      {editing && phone ? <ExtensionAssignment type="phone" targetId={phone.id} onSaved={onExtensionSaved} /> : null}
      {editing && (phone?.vendor === "polycom" || (phone?.vendor === "audiocodes" && ["420HD", "440HD"].includes(phone.model)) || (phone?.vendor === "yealink" && phone.model === "T22P")) ? <PolycomProvisioningCard key={phone.id} phone={phone} /> : null}
      {editing && phone ? <PhoneCtiCard phone={phone} /> : null}

    </>
  );
}

function PhoneModelSettingsCard({ vendor, model, settings, updateSettings, draft, update, bridges = [] }) {
  const tUi = useUiText();
  const useBridge = ["local_bridge", "desktop_bridge"].includes(settings.cti_mode);
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="mb-3 text-sm font-medium">{tUi("Context settings view")}{model ? tUi(" · {value0}", { value0: model }) : ""}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>{tUi("Line keys")}</Label>
          <Input className="mt-1" value={settings.line_keys || ""} onChange={(e) => updateSettings({ line_keys: e.target.value })} placeholder="1" />
        </div>
        <div>
          <Label>{tUi("CTI mode")}</Label>
          <Select value={settings.cti_mode || "direct"} onValueChange={(v) => updateSettings({ cti_mode: v })}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder={tUi("CTI mode")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="direct">{tUi("Direct phone API")}</SelectItem>
              {vendor === "audiocodes" ? <SelectItem value="sip_controller">{tUi("Local SIP controller")}</SelectItem> : null}
              {((vendor === "audiocodes" && ["420HD", "440HD"].includes(model)) || vendor === "polycom" || (vendor === "yealink" && model === "T22P")) ? <SelectItem value="desktop_bridge">Electron · {tUi("Local bridge")}</SelectItem> : null}
              <SelectItem value="local_bridge">{tUi("Local bridge")}</SelectItem>
              <SelectItem value="telnyx">{tUi("Telnyx fallback")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {vendor === "audiocodes" && settings.cti_mode === "desktop_bridge" ? <>
          <div><Label>{tUi("IP address")} · Electron</Label><Input className="mt-1" value={settings.sip_controller_host || ""} onChange={e=>updateSettings({sip_controller_host:e.target.value})} placeholder="192.168.1.20" /></div>
          <div><Label>{tUi("Port")} · SIP TCP</Label><Input className="mt-1" type="number" min="1024" max="65535" value={settings.sip_controller_port || 5070} onChange={e=>updateSettings({sip_controller_port:e.target.value})} /></div>
        </> : null}
        <div className="sm:col-span-2">
          <Label>{tUi("Local bridge")}</Label>
          <Select value={draft.local_bridge_id || "none"} onValueChange={(v) => update({ local_bridge_id: v === "none" ? "" : v })} disabled={!useBridge}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder={tUi("Select local bridge")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{tUi("No bridge assigned")}</SelectItem>
              {bridges.map((b) => (
                <SelectItem key={b.bridge_id} value={b.bridge_id}>{b.label || b.bridge_id} · {b.online ? tUi("online") : tUi("offline")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>{tUi("SNTP server")}</Label>
          <Input className="mt-1 font-mono" value={settings.sntp_server || ""} onChange={(e) => updateSettings({ sntp_server: e.target.value })} placeholder={tUi("pool.ntp.org")} />
        </div>
        <div>
          <Label>{tUi("NTP timezone offset")}</Label>
          <Select value={settings.ntp_timezone || "UTC"} onValueChange={(v) => updateSettings({ ntp_timezone: v })}>
            <SelectTrigger className="mt-1 w-full"><SelectValue placeholder={tUi("Select timezone offset")} /></SelectTrigger>
            <SelectContent>
              {PHONE_TIMEZONES.map((tz) => <SelectItem key={tz.value} value={tz.value}>{tUi(tz.label)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-3 space-y-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.timezone_discovery !== false} onChange={(e) => updateSettings({ timezone_discovery: e.target.checked })} />{tUi(" Timezone discovery from DHCP / site defaults")}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.dynamic_reload !== false} onChange={(e) => updateSettings({ dynamic_reload: e.target.checked })} />{tUi(" Dynamic reload / periodic provisioning checks")}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.automatic_firmware_updates !== false} onChange={(e) => updateSettings({ automatic_firmware_updates: e.target.checked })} />{tUi(" Automatic firmware updates")}</label>
      </div>
    </div>
  );
}

function PhoneModelPreview({ vendor, model, catalogEntry }) {
  const tUi = useUiText();
  return (
    <div className="overflow-hidden rounded-xl border bg-muted/20">
      <div className="aspect-[4/3] p-2">
        <StationArtwork station={{ vendor, model, kind: "deskphone" }} size="preview" className="h-full w-full" />
      </div>
      <div className="border-t px-3 py-2">
        <div className="text-sm font-medium">{model}</div>
        <a className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:underline dark:text-sky-300" href={catalogEntry.docs} target="_blank" rel="noreferrer">{tUi("Full manufacturer documentation ")}<IconExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

// CTI control card — drives the phone through the vendor driver (Polycom
// REST, Yealink Action URI, Telnyx fallback for AudioCodes/NAT-ed phones).
function normalizeCallState(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function primaryCallFromStatus(status) {
  const result = status?.result || status || {};
  const calls = asArray(result.call || result.data?.call || result.data);
  return calls.find((call) => call && typeof call === "object" && (call.CallHandle || call.Ref || call.CallState || call.state)) || null;
}
function callHandle(call) {
  return call?.CallHandle || call?.Ref || call?.call_control_id || call?.id || "";
}

function explicitMuteValue(status) {
  const result = status?.result || status || {};
  const call = primaryCallFromStatus(status);
  const value = call?.Muted ?? call?.Mute ?? result.muted ?? result.mute;
  if (value === undefined || value === null || value === "") return null;
  return ["true", "1", "on", "muted", "yes"].includes(String(value).toLowerCase());
}

function mergeStatusWithStickyMute(nextStatus, previousStatus) {
  if (!nextStatus || !previousStatus) return nextStatus;
  const nextInfo = deriveCallInfo(nextStatus, null);
  if (!nextInfo.hasCall) return nextStatus;
  if (explicitMuteValue(nextStatus) !== null) return nextStatus;
  const previousInfo = deriveCallInfo(previousStatus, null);
  if (!previousInfo.hasCall || !callHandle(nextInfo.call) || callHandle(nextInfo.call) !== callHandle(previousInfo.call)) return nextStatus;
  if (explicitMuteValue(previousStatus) === null) return nextStatus;
  return applyOptimisticCtiState(nextStatus, previousInfo.isMuted ? "mute" : "unmute");
}

function phoneStatusSummary(status, phone) {
  const result = status?.result || status || {};
  const line = asArray(result.line || result.data?.line).find(Boolean) || {};
  const registration = result.registration || result.registration_status || line.RegistrationStatus || line.LineState || "unknown";
  const info = deriveCallInfo(status, phone);
  const parts = [`Registration: ${registration}`];
  parts.push(info.hasCall ? `Call: ${info.label || info.state}${info.from !== "—" ? ` · From ${info.from}` : ""}${info.to !== "—" ? ` → ${info.to}` : ""}` : "Call: idle");
  if (result.reachable !== undefined || status?.reachable !== undefined) parts.push(`Reachable: ${(result.reachable ?? status.reachable) ? "yes" : "no"}`);
  if (result.discovered_ip || result.ip) parts.push(`IP: ${result.discovered_ip || result.ip}`);
  return parts.join(" · ");
}


function deriveCallInfo(status, phone) {
  const result = status?.result || status || {};
  const call = primaryCallFromStatus(status);
  const state = normalizeCallState(call?.CallState || call?.state || result.call_state || result.state);
  const disconnectedStates = new Set(["", "disconnected", "idle", "ended", "completed", "failed", "no_active_call"]);
  const connectedStates = new Set(["connected", "call_connected", "active", "confirmed", "in_call", "talking", "answered", "bridged"]);
  const dialingStates = new Set(["proceeding", "call_proceeding", "ringback", "call_ringback", "dialing", "outgoing", "trying", "originating"]);
  const incomingStates = new Set(["incoming", "call_incoming", "ringing", "call_ringing", "offering", "alerting", "ring", "presenting"]);
  const heldStates = new Set(["held", "hold", "call_hold", "call_held", "on_hold", "local_hold", "remote_hold"]);
  const explicitMute = explicitMuteValue(status);
  const direction = String(call?.Type || call?.direction || result.direction || "").toLowerCase();
  const hasOutgoingDirection = direction === "outgoing" || direction === "outbound";
  const isInbound = direction === "incoming" || direction === "inbound" || (!hasOutgoingDirection && incomingStates.has(state));
  const isHeld = heldStates.has(state) || String(call?.HoldState || "").toLowerCase().includes("hold");
  const isMuted = explicitMute === true;
  const hasCall = Boolean(call) && !disconnectedStates.has(state);
  const isConnected = hasCall && (connectedStates.has(state) || heldStates.has(state));
  const isDialing = dialingStates.has(state);
  const isIncoming = hasCall && !isConnected && (incomingStates.has(state) || (isInbound && !dialingStates.has(state)));
  const remoteNumber = call?.RemotePartyNumber || call?.remote_party_number || call?.RemotePartyName || call?.to || result.to || "";
  const localNumber = call?.LocalPartyNumber || call?.local_party_number || phone?.assigned_phone_number || "";
  return {
    call,
    state: state || "idle",
    label: call?.CallState || call?.state || (hasCall ? "Active" : "Idle"),
    hasCall,
    isIncoming,
    isHeld,
    isMuted,
    isConnected,
    isDialing,
    isInbound,
    from: isInbound ? (remoteNumber || "—") : (localNumber || "—"),
    to: isInbound ? (localNumber || "—") : (remoteNumber || "—"),
    duration: call?.DurationInSeconds && call.DurationInSeconds !== "-1" ? `${call.DurationInSeconds}s` : null,
    handle: call?.CallHandle || call?.Ref || "",
    reachable: result.reachable ?? status?.reachable ?? null,
  };
}

function applyOptimisticCtiState(status, action) {
  const next = status ? structuredClone(status) : { call: {} };
  const result = next.result || next;
  const call = primaryCallFromStatus(result) || result.call || result.data?.call || {};
  const patch = action === "hold"
    ? { CallState: "Held" }
    : action === "resume"
      ? { CallState: "Connected" }
      : action === "mute"
        ? { Muted: "true" }
        : action === "unmute"
          ? { Muted: "false" }
          : {};
  Object.assign(call, patch);
  if (Array.isArray(result.call)) result.call[0] = call;
  else if (result.call) result.call = call;
  else if (result.data?.call) result.data.call = call;
  else result.call = call;
  return next;
}

function callStateBadgeClass(info) {
  if (info.isIncoming) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (info.isHeld) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (info.hasCall) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
}

function CtiIconButton({ action, label, icon: Icon, active = false, disabled = false, busy, onClick, testId }) {
  const tUi = useUiText();
  return (
    <Button
      type="button"
      size="icon"
      variant={active ? "default" : "outline"}
      className="h-11 min-w-0 flex-1"
      disabled={disabled || Boolean(busy)}
      onClick={onClick}
      title={tUi(label)}
      aria-label={tUi(label)}
      data-testid={testId || `hp-cti-${action}`}
    >
      {busy === action ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
    </Button>
  );
}

function PhoneMaintenanceActions({ phone, rebootPhones, rebooting = false }) {
  const tUi = useUiText();
  const [busy, setBusy] = useState(null);
  const reachableIp = phone?.last_ip || phone?.ip_address || "";
  const [hostOverride, setHostOverride] = useState("");
  async function run(action) {
    setBusy(action);
    try {
      const manualHost = reachableIp ? "" : hostOverride.trim();
      const res = await fetch(`${API}/phones/${phone.id}/cti`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(manualHost ? { host: manualHost } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${action} failed`);
      notify({ title: tUi("Phone {value0}", {value0: action}), description: action === "status" ? phoneStatusSummary(data.result, phone) : "Command accepted", variant: "success" });
    } catch (err) {
      notify({ title: tUi("Phone {value0} failed", {value0: action}), description: err.message, variant: "error" });
    } finally {
      setBusy(null);
    }
  }
  const actionButton = (action, label, Icon, testId, onClick = () => run(action), disabled = false) => (
    <Button size="sm" variant="outline" className="h-10 min-w-0 flex-1" disabled={Boolean(busy) || disabled} onClick={onClick} data-testid={testId} title={label} aria-label={label}>
      {busy === action ? <IconLoader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      <span className="sr-only">{label}</span>
    </Button>
  );
  return (
    <div className="border-t pt-3">
      <div className="mb-2 text-xs font-medium text-muted-foreground">{tUi("Phone actions")}</div>
      {!reachableIp ? (
        <Input
          value={hostOverride}
          onChange={(event) => setHostOverride(event.target.value)}
          placeholder={tUi("Temporary phone IP/host")}
          className="mb-2 h-9 text-xs"
          data-testid="hp-sip-host-override"
          aria-label={tUi("Temporary phone IP or host for actions")}
        />
      ) : null}
      <div className="grid grid-cols-3 gap-2" data-testid="hp-sip-registration-actions">
        {actionButton("status", "Check status", IconRefresh, "hp-sip-check-status")}
        {actionButton("reprovision", "Re-provision", IconWand, "hp-sip-reprovision")}
        {actionButton("reboot", "Reboot", IconPower, "hp-sip-reboot", () => {
          const manualHost = reachableIp ? "" : hostOverride.trim();
          rebootPhones?.([phone.id], manualHost ? { hostOverrides: { [phone.id]: manualHost } } : {});
        }, rebooting || !phone?.id)}
      </div>
    </div>
  );
}

function PhoneCtiCard({ phone }) {
  const tUi = useUiText();
  const [busy, setBusy] = useState(null);
  const [dialNumber, setDialNumber] = useState("");
  const [lastStatus, setLastStatus] = useState(null);
  const [ctiError, setCtiError] = useState("");
  const ringtoneRef = useRef(null);

  const ctiMode = phone?.settings?.cti_mode === "desktop_bridge" ? "Electron CTI bridge" : phone?.settings?.cti_mode === "sip_controller" ? "Local SIP controller" : phone?.settings?.cti_mode === "local_bridge" ? `Local bridge (${phone.local_bridge_id || phone.settings?.local_bridge_id || "unassigned"})` : phone.vendor === "audiocodes" || phone?.settings?.cti_mode === "telnyx" ? "Telnyx Call Control" : phone.vendor === "polycom" ? "Polycom REST API" : "Yealink Action URI";
  const reachableIp = phone.last_ip || phone.ip_address;
  const callInfo = useMemo(() => deriveCallInfo(lastStatus, phone), [lastStatus, phone]);
  const hasActiveCall = callInfo.hasCall;
  const fireAndForgetControls = phone.vendor === "yealink" && phone?.settings?.cti_mode !== "telnyx" && Boolean(reachableIp);
  const telnyxFallbackControls = (phone.vendor === "audiocodes" && !["sip_controller","desktop_bridge"].includes(phone?.settings?.cti_mode)) || phone?.settings?.cti_mode === "telnyx";
  const canDial = (fireAndForgetControls || !hasActiveCall) && dialNumber.trim();
  const canAnswer = callInfo.isIncoming || fireAndForgetControls;
  const canHold = callInfo.isConnected || fireAndForgetControls;
  const canMute = (callInfo.isConnected && !callInfo.isHeld && !telnyxFallbackControls) || fireAndForgetControls;
  const muteDisabledReason = telnyxFallbackControls ? "Mute is not available for Telnyx hardphone bridge calls" : callInfo.isHeld ? "Mute is not available while held" : "Mute";
  const canHangup = hasActiveCall || fireAndForgetControls;

  const fetchCtiStatus = useCallback(async ({ silent = true } = {}) => {
    if (!phone?.id) return null;
    if (!silent) setBusy("status");
    try {
      const res = await fetch(`${API}/phones/${phone.id}/cti`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", silent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "status failed");
      const nextStatus = data.result || null;
      setLastStatus((current) => mergeStatusWithStickyMute(nextStatus, current));
      return nextStatus;
    } catch (err) {
      if (!silent) notify({ title: "CTI status failed", description: err.message, variant: "error" });
      return null;
    } finally {
      if (!silent) setBusy(null);
    }
  }, [phone?.id]);

  useEffect(() => {
    setLastStatus(null);
    fetchCtiStatus({ silent: true });
    const timer = window.setInterval(() => fetchCtiStatus({ silent: true }), 3000);
    return () => window.clearInterval(timer);
  }, [fetchCtiStatus]);

  const stopIncomingRingtone = useCallback(() => {
    const audio = ringtoneRef.current;
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {}
  }, []);

  useEffect(() => {
    if (!callInfo.isIncoming) {
      stopIncomingRingtone();
      return;
    }
    if (!ringtoneRef.current) {
      const audio = new Audio(HARDPHONE_RINGTONE_URL);
      audio.loop = true;
      audio.preload = "auto";
      ringtoneRef.current = audio;
    }
    const audio = ringtoneRef.current;
    audio.play().catch(() => {
      // Browser autoplay can be blocked until the user interacts with the page.
      // The visual incoming-call state and Answer button still remain active.
    });
  }, [callInfo.isIncoming, stopIncomingRingtone]);

  useEffect(() => () => stopIncomingRingtone(), [stopIncomingRingtone]);

  async function runCti(action, params = {}) {
    if (["answer", "hangup", "dial"].includes(action)) stopIncomingRingtone();
    setBusy(action);
    setCtiError("");
    try {
      const res = await fetch(`${API}/phones/${phone.id}/cti`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, callRef: (Array.isArray(lastStatus?.call) ? lastStatus.call[0] : lastStatus?.call)?.Ref, ...params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${action} failed`);
      if (action === "status") {
        setLastStatus((current) => mergeStatusWithStickyMute(data.result || null, current));
      } else if (!["reboot", "reprovision"].includes(action)) {
        if (["hold", "resume", "mute", "unmute"].includes(action)) {
          setLastStatus((current) => applyOptimisticCtiState(current, action));
        }
        window.setTimeout(() => fetchCtiStatus({ silent: true }), 1200);
      }
    } catch (err) {
      setCtiError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const toggleHoldAction = callInfo.isHeld ? "resume" : "hold";
  const toggleMuteAction = callInfo.isMuted ? "unmute" : "mute";

  return (
    <SettingCard icon={IconActivity} title={tUi("CTI control")}>
      <div className="space-y-3">
        {!reachableIp && phone.vendor !== "audiocodes" ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{tUi("No known phone IP yet — wait for provisioning or bridge discovery before using local CTI.")}</p>
        ) : null}
        <div className="space-y-2 rounded-xl border bg-muted/20 p-2" data-testid="hp-cti-toolbar">
          <Input className="h-10 w-full font-mono" value={dialNumber} onChange={(e) => setDialNumber(e.target.value)} placeholder="+48123456789" disabled={hasActiveCall || Boolean(busy)} />
          <div className="grid grid-cols-5 gap-2">
            <CtiIconButton action="dial" label={tUi("Dial")} icon={IconPhoneCall} disabled={!canDial} busy={busy} onClick={() => runCti("dial", { number: dialNumber.trim() })} testId="hp-cti-dial" />
            <CtiIconButton action="answer" label={tUi("Answer")} icon={IconPhoneIncoming} disabled={!canAnswer} busy={busy} onClick={() => runCti("answer")} />
            <CtiIconButton action={toggleHoldAction} label={callInfo.isHeld ? tUi("Resume") : tUi("Hold", undefined, "phone action")} icon={callInfo.isHeld ? IconPlayerPlay : IconPlayerPause} active={callInfo.isHeld} disabled={!canHold} busy={busy} onClick={() => runCti(toggleHoldAction)} testId="hp-cti-hold-toggle" />
            <CtiIconButton action={toggleMuteAction} label={tUi(callInfo.isMuted ? tUi("Unmute") : muteDisabledReason)} icon={callInfo.isMuted ? IconMicrophone : IconMicrophoneOff} active={callInfo.isMuted} disabled={!canMute} busy={busy} onClick={() => runCti(toggleMuteAction)} testId="hp-cti-mute-toggle" />
            <CtiIconButton action="hangup" label={tUi("Hang up")} icon={IconPhoneOff} disabled={!canHangup} busy={busy} onClick={() => runCti("hangup")} />
          </div>
        </div>
        {ctiError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="hp-cti-inline-error">
            {ctiError}
          </div>
        ) : null}
        <div className="rounded-xl border bg-muted/20 p-3" data-testid="hp-cti-call-info">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tUi("Current call")}</div>
            <Badge variant="outline" className={callStateBadgeClass(callInfo)}>{operationalStatusLabel(tUi, String(callInfo.label).toLowerCase())}</Badge>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg bg-background/70 px-2 py-1.5">
              <div className="text-muted-foreground">{tUi("From")}</div>
              <div className="truncate font-mono">{callInfo.from}</div>
            </div>
            <div className="rounded-lg bg-background/70 px-2 py-1.5">
              <div className="text-muted-foreground">{tUi("To")}</div>
              <div className="truncate font-mono">{callInfo.to}</div>
            </div>
            <div className="rounded-lg bg-background/70 px-2 py-1.5">
              <div className="text-muted-foreground">{tUi("Reachability")}</div>
              <div className="font-medium">{callInfo.reachable === null ? tUi("Unknown") : callInfo.reachable ? tUi("Reachable") : tUi("Not reachable")}</div>
            </div>
            <div className="rounded-lg bg-background/70 px-2 py-1.5">
              <div className="text-muted-foreground">{tUi("Details")}</div>
              <div className="truncate font-medium">{callInfo.duration ? tUi("Duration {value0}", { value0: callInfo.duration }) : callInfo.handle ? tUi("Handle {value0}", { value0: callInfo.handle }) : tUi("No active call")}</div>
            </div>
          </div>
        </div>
      </div>
    </SettingCard>
  );
}

function SettingsSummaryView() {
  const tUi = useUiText();
  const [origin, setOrigin] = useState("");
  useEffect(() => { try { setOrigin(window.location.origin); } catch {} }, []);
  const provisioningUrl = `${origin || "https://<your-host>"}/api/provisioning/`;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-background/85 p-5 shadow-sm">
        <h3 className="text-lg font-semibold">{tUi("Provisioning endpoint")}</h3>
        <p className="text-sm text-muted-foreground">{tUi("Phones download generated config files from this URL at boot and on their polling schedule.")}</p>
        <div className="mt-3 rounded-lg border bg-muted/30 px-3 py-2 font-mono text-sm">{provisioningUrl}</div>
      </div>

      <SettingCard icon={IconServer} title={tUi("Zero-touch setup")} subtitle={tUi("Point factory phones at the provisioning endpoint")}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li><span className="font-medium text-foreground">{tUi("DHCP option 66 / 160")}</span>{tUi(" — set the value to the provisioning URL above; phones pick it up at boot.")}</li>
          <li><span className="font-medium text-foreground">{tUi("Vendor redirect services")}</span>{tUi(" — Poly ZTP / Poly Lens, Yealink RPS, AudioCodes Redirect can map phone MACs to this URL for drop-ship deployments.")}</li>
          <li><span className="font-medium text-foreground">{tUi("Manual")}</span>{tUi(" — enter the URL in the phone menu or web UI (Provisioning Server / Auto Provision).")}</li>
        </ul>
      </SettingCard>

      <SettingCard icon={IconRouteAltLeft} title={tUi("NAT and local-network CTI")} subtitle={tUi("Managed hardphones without inbound firewall holes")}>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>{tUi("Direct Poly REST and Yealink Action URI need server-to-phone reachability. For phones behind customer NAT, prefer ")}<span className="font-medium text-foreground">{tUi("Telnyx Call Control fallback")}</span>{tUi(": the phone registers outbound to Telnyx, auto-answers the CTI leg, and the Contact Center controls that Telnyx leg instead of opening inbound firewall access to the handset.")}</p>
          <p>{tUi("For true local key-level control with NAT-ed phones, use a small LAN bridge/agent that opens an outbound WebSocket to CC and proxies local phone REST/Action URI calls. A browser plugin is possible but weaker operationally because of credentials, CORS/Private Network Access and enterprise rollout policy.")}</p>
        </div>
      </SettingCard>

      <SettingCard icon={IconDeviceLandlinePhone} title={tUi("Served file conventions")} subtitle={tUi("Files generated per request from the phone inventory")}>
        <div className="space-y-2 text-sm">
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-medium">{tUi("Polycom / Poly")}</div>
            <div className="font-mono text-xs text-muted-foreground">{tUi("<mac>.cfg → master config · <mac>-reg.cfg → registration (XML)")}</div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-medium">{tUi("Yealink")}</div>
            <div className="font-mono text-xs text-muted-foreground">{tUi("y000000000000.cfg → common defaults · <mac>.cfg → account config")}</div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-medium">{tUi("AudioCodes")}</div>
            <div className="font-mono text-xs text-muted-foreground">{tUi("<mac>.cfg → INI config (405HD / 445HD / 450HD, UC firmware)")}</div>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={IconShieldCheck} title={tUi("Security model")} subtitle={tUi("How credentials are protected")}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>{tUi("Only phones present in the inventory are served config files — unknown MACs get 404 and are logged.")}</li>
          <li>{tUi("Each phone gets its own Telnyx telephony credential; deleting the phone deletes the credential.")}</li>
          <li>{tUi("Factory admin passwords are replaced during provisioning.")}</li>
          <li>{tUi("Run the endpoint behind HTTPS — config files carry SIP secrets.")}</li>
        </ul>
      </SettingCard>
    </div>
  );
}

function bridgeStatusBadgeClass(online) {
  return online ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300";
}

function bridgePhoneCount(bridge, phones = []) {
  if (!bridge?.bridge_id) return 0;
  return phones.filter((p) => (p.local_bridge_id || p.settings?.local_bridge_id) === bridge.bridge_id).length;
}

function BridgesListView({ bridges = [], phones = [], selectedBridgeId, setSelectedBridgeId }) {
  const tUi = useUiText();
  if (!bridges.length) return <Empty title={tUi("No local bridges yet")} description={tUi("Create a bridge enrollment from Context settings, then run the Docker bridge in the customer LAN.")} />;
  return (
    <div className="space-y-3">
      {bridges.map((bridge) => {
        const selected = bridge.bridge_id === selectedBridgeId;
        return (
          <button
            key={bridge.bridge_id}
            type="button"
            onClick={() => setSelectedBridgeId(bridge.bridge_id)}
            className={`w-full rounded-2xl border bg-background/80 p-4 text-left shadow-sm transition hover:border-sky-500/50 ${selected ? "border-sky-500/70 ring-2 ring-sky-500/15" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{bridge.label || bridge.bridge_id}</h3>
                  <Badge variant="outline" className={bridgeStatusBadgeClass(bridge.online)}>{bridge.online ? tUi("online") : tUi("offline")}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{bridge.bridge_id}</p>
              </div>
              <IconRouteAltLeft className="h-5 w-5 shrink-0 text-muted-foreground" />
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <MiniStat label={tUi("Bridge status")} value={bridge.online ? tUi("Online") : tUi("Offline")} icon={IconActivity} tone={bridge.online ? "emerald" : "amber"} />
              <MiniStat label={tUi("Connected phones")} value={bridgePhoneCount(bridge, phones)} icon={IconDeviceLandlinePhone} tone="blue" />
              <MiniStat label={tUi("Last seen")} value={formatTime(bridge.last_seen_at)} icon={IconClockHour4} tone="violet" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function CopyButton({ value, label = "Copy" }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value || "");
      notify({ title: "Copied", description: label, variant: "success" });
    } catch (err) {
      notify({ title: "Copy failed", description: err.message, variant: "error" });
    }
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} disabled={!value}>
      <IconCopy className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

function BridgeEditor({ bridges = [], bridge, phones = [], refresh, onSelect }) {
  const tUi = useUiText();
  const [label, setLabel] = useState("Local office bridge");
  const [site, setSite] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [enrollment, setEnrollment] = useState(null);
  // Custom confirm dialog for bridge delete (no native window.confirm — project convention).
  const [confirmDeleteBridge, setConfirmDeleteBridge] = useState(false);
  const assignedPhones = bridge ? phones.filter((p) => (p.local_bridge_id || p.settings?.local_bridge_id) === bridge.bridge_id) : [];
  const hasSelectedBridge = Boolean(bridge?.bridge_id);

  useEffect(() => {
    if (!hasSelectedBridge) {
      setLabel("Local office bridge");
      setSite("");
      return;
    }
    setLabel(bridge.label || "");
    setSite(bridge.site || bridge.location || "");
    setEnrollment(null);
  }, [hasSelectedBridge, bridge?.bridge_id]);

  async function createBridge() {
    setCreating(true);
    try {
      const res = await fetch(`${API}/bridges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, site }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Bridge enrollment failed");
      setEnrollment(data.enrollment || null);
      if (data.bridge?.bridge_id) onSelect?.(data.bridge.bridge_id);
      notify({ title: "Local bridge enrolled", description: data.bridge?.bridge_id, variant: "success" });
      await refresh?.(false);
    } catch (err) {
      notify({ title: "Bridge enrollment failed", description: err.message, variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  async function updateBridge() {
    if (!bridge?.bridge_id) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/bridges`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bridge_id: bridge.bridge_id, label, site }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Bridge update failed");
      notify({ title: "Bridge updated", description: data.bridge?.bridge_id || bridge.bridge_id, variant: "success" });
      await refresh?.(false);
    } catch (err) {
      notify({ title: "Bridge update failed", description: err.message, variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  // Open the custom confirm dialog (project convention: no native window.confirm).
  function deleteBridge() {
    if (!bridge?.bridge_id || assignedPhones.length) return;
    setConfirmDeleteBridge(true);
  }

  async function performDeleteBridge() {
    if (!bridge?.bridge_id || assignedPhones.length) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API}/bridges?bridge_id=${encodeURIComponent(bridge.bridge_id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Bridge delete failed");
      notify({ title: "Bridge deleted", description: bridge.bridge_id, variant: "success" });
      const nextBridge = bridges.find((item) => item.bridge_id !== bridge.bridge_id) || null;
      onSelect?.(nextBridge?.bridge_id || null);
      await refresh?.(false);
    } catch (err) {
      notify({ title: "Bridge delete failed", description: err.message, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingCard icon={IconRouteAltLeft} title={tUi("Bridge configuration")} subtitle={tUi(hasSelectedBridge ? "Update the selected bridge label and location" : "Create an outbound WebSocket bridge enrollment for a LAN site")}>
        <div className="space-y-3">
          {hasSelectedBridge ? (
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <div className="text-muted-foreground">{tUi("Selected bridge")}</div>
              <div className="mt-1 font-mono text-foreground">{bridge.bridge_id}</div>
            </div>
          ) : null}
          <div>
            <Label>{tUi("Bridge label")}</Label>
            <Input className="mt-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tUi("Warsaw office bridge")} />
          </div>
          <div>
            <Label>{tUi("Location")}</Label>
            <Input className="mt-1" value={site} onChange={(e) => setSite(e.target.value)} placeholder={tUi("Warsaw LAN")} />
          </div>
          <div className="flex flex-wrap gap-2">
            {hasSelectedBridge ? (
              <>
                <Button size="sm" className={neutralActionClass} onClick={updateBridge} disabled={saving || !label.trim()} data-testid="hp-update-local-bridge">
                  {saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconDeviceFloppy className="mr-2 h-4 w-4" />}{tUi("Update")}</Button>
                <Button size="sm" variant="destructive" onClick={deleteBridge} disabled={deleting || assignedPhones.length > 0} data-testid="hp-delete-local-bridge">
                  {deleting ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconTrash className="mr-2 h-4 w-4" />}{tUi("Delete bridge")}</Button>
              </>
            ) : (
              <Button size="sm" className={neutralActionClass} onClick={createBridge} disabled={creating || !label.trim()} data-testid="hp-create-local-bridge">
                {creating ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconRouteAltLeft className="mr-2 h-4 w-4" />}{tUi("Create bridge enrollment")}</Button>
            )}
          </div>
          {hasSelectedBridge && assignedPhones.length ? (
            <p className="text-xs text-muted-foreground">{tUi("Remove all phones from this bridge before deleting it.")}</p>
          ) : null}
          {enrollment ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-amber-800 dark:text-amber-200">{tUi("Copy this token now — it is shown only once.")}</div>
                <CopyButton value={enrollment.env || `BRIDGE_ID=${enrollment.bridge_id}\nBRIDGE_TOKEN=${enrollment.token}\nCC_WS_URL=${enrollment.cc_ws_url}`} label={tUi("Copy .env")} />
              </div>
              <pre className="mt-2 max-w-full whitespace-pre-wrap break-all rounded-md border bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-foreground">{enrollment.env || `BRIDGE_ID=${enrollment.bridge_id}\nBRIDGE_TOKEN=${enrollment.token}\nCC_WS_URL=${enrollment.cc_ws_url}`}</pre>
            </div>
          ) : null}
        </div>
      </SettingCard>

      <SettingCard icon={IconActivity} title={tUi("Bridge status")} subtitle={tUi("Live relay presence and phones assigned to this bridge")}>
        {bridge ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
              <span className="min-w-0 font-mono text-xs">{bridge.bridge_id}</span>
              <Badge variant="outline" className={bridgeStatusBadgeClass(bridge.online)}>{bridge.online ? tUi("online") : tUi("offline")}</Badge>
            </div>
            {assignedPhones.length ? (
              <div className="max-h-[25rem] space-y-1.5 overflow-y-auto pr-1" data-testid="hp-bridge-phone-scroll-list">
                {assignedPhones.map((phone) => (
                  <div key={phone.id} className="rounded-lg border bg-background/70 px-3 py-2 text-xs">
                    <div className="truncate font-medium">{phone.phone_name || phone.label || formatMacDisplay(phone.mac)}</div>
                    <div className="mt-0.5 truncate text-muted-foreground">{formatMacDisplay(phone.mac)} · {phone.last_ip || phone.ip_address || tUi("no IP")}</div>
                  </div>
                ))}
              </div>
            ) : <p className="text-xs text-muted-foreground">{tUi("No phones are assigned to this bridge yet.")}</p>}
          </div>
        ) : <p className="text-sm text-muted-foreground">{tUi("Create or select a bridge to see its live status.")}</p>}
      </SettingCard>

      {/* Custom confirm: Delete bridge (replaces native window.confirm) */}
      <AlertDialog open={confirmDeleteBridge} onOpenChange={(open) => { if (!open) setConfirmDeleteBridge(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tUi("Delete bridge?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {bridge
                ? <>{tUi("This permanently deletes the bridge ")}<span className="font-medium text-foreground">{bridge.label || bridge.bridge_id}</span>{tUi(". This action cannot be undone.")}</>
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tUi("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={() => { setConfirmDeleteBridge(false); performDeleteBridge(); }}
            >
              {deleting ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : <IconTrash className="mr-2 h-4 w-4" />}{tUi("Delete bridge")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SettingsEditor() {
  const tUi = useUiText();
  return (
    <div className="space-y-4">
      <SettingCard icon={IconSettings} title={tUi("Provisioning defaults")} subtitle={tUi("Phase 1 serves Telnyx defaults")}>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{tUi("Config files are generated with ")}<span className="font-mono text-foreground">{tUi("sip.telnyx.com")}</span>{tUi(", UDP transport and hourly re-provisioning polling.")}</p>
          <p>{tUi("Per-phone IP override controls direct Poly REST / Yealink Action URI. For phones behind NAT, use ")}<span className="font-mono text-foreground">{tUi("settings.cti_mode = \"local_bridge\"")}</span>{tUi(" for full local CTI, or ")}<span className="font-mono text-foreground">{tUi("settings.cti_mode = \"telnyx\"")}</span>{tUi(" for Call Control fallback.")}</p>
        </div>
      </SettingCard>
    </div>
  );
}
