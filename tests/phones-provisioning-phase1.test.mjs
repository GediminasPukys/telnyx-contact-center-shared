import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "./helpers/ui-source.mjs";
import { existsSync, readdirSync } from "node:fs";
import {
  createPhoneSipConnection,
  clearPhoneSipConnectionCallerId,
  phoneConnectionUserName,
  phoneConnectionName,
} from "../lib/hardphones/credentials.mjs";
import {
  normalizeMac,
  phoneLineLabel,
  validatePhoneLineLabel,
  formatMac,
  resolveProvisioningRequest,
  buildConfigForPhone,
  polycomMasterConfig,
  polycomRegistrationConfig,
  yealinkCommonConfig,
  yealinkPhoneConfig,
  audiocodesPhoneConfig,
  vendorFromUserAgent,
  SUPPORTED_VENDORS,
} from "../lib/hardphones/config-generators.mjs";

async function src(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const phone = {
  mac: "0004f2abcdef",
  vendor: "polycom",
  model: "VVX 450",
  label: "Desk 12",
  sip_username: "gencredabc123",
  sip_password: "secretpw",
  admin_password: "newadminpw",
  settings: {
    line_keys: 3,
    sntp_server: "time.example.com",
    dynamic_reload: true,
    automatic_firmware_updates: true,
    firmware_source: "https://firmware.example.com/poly/",
    custom_config_url: "https://cfg.example.com/extra.cfg",
    syslog_server: "10.0.0.10",
  },
};

function currentOffsetSeconds(timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date());
  const value = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  if (value === "GMT" || value === "UTC") return 0;
  const match = value.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  assert.ok(match, `Expected parseable timezone offset, got ${value}`);
  const sign = match[1] === "-" ? -1 : 1;
  return sign * ((Number(match[2]) * 3600) + (Number(match[3] || 0) * 60));
}

describe("hard phones provisioning (Phase 1)", () => {
  it("normalizes and formats MAC addresses", () => {
    assert.strictEqual(normalizeMac("00:04:F2:AB:CD:EF"), "0004f2abcdef");
    assert.strictEqual(normalizeMac("0004f2abcdef"), "0004f2abcdef");
    assert.strictEqual(normalizeMac("not-a-mac"), null);
    assert.strictEqual(normalizeMac(""), null);
    assert.strictEqual(formatMac("0004F2ABCDEF"), "00:04:f2:ab:cd:ef");
    assert.deepStrictEqual(SUPPORTED_VENDORS, ["polycom", "yealink", "audiocodes"]);
  });

  it("preserves custom line labels over extensions and restores the default when cleared", () => {
    assert.equal(phoneLineLabel({...phone,extension:"1001",label:"Conference Warsaw"}), "Conference Warsaw");
    assert.equal(phoneLineLabel({...phone,extension:"1001",label:null}), "1001");
    assert.throws(()=>validatePhoneLineLabel("a\nb","polycom"), /control characters/);
    assert.throws(()=>validatePhoneLineLabel("a".repeat(100),"yealink"), /99/);
    assert.equal(validatePhoneLineLabel("a".repeat(256),"polycom").length,256);
    assert.match(polycomRegistrationConfig({...phone,extension:"1001",label:'Room & "Board"'}), /reg\.1\.label="Room &amp; &quot;Board&quot;"/);
    assert.ok(audiocodesPhoneConfig({...phone,model:"440HD",label:"Conference"}).includes("voip/line/0/extension_display=Conference"));
  });

  it("uses assigned 3–5 digit extensions on every vendor display without changing SIP credentials", () => {
    for (const extension of ["101", "1001", "10001"]) {
      const assigned = { ...phone, label: null, extension, assigned_phone_number:"+15551234567" };
      const poly = polycomRegistrationConfig(assigned);
      assert.match(poly, new RegExp(`reg\\.1\\.label="${extension}"`));
      assert.match(poly, new RegExp(`reg\\.1\\.displayName="${extension}"`));
      assert.match(poly, /reg\.1\.auth\.userId="gencredabc123"/);
      assert.match(poly, /reg\.1\.address="gencredabc123"/);
      const yealink = yealinkPhoneConfig(assigned);
      assert.ok(yealink.includes(`account.1.label = ${extension}`));
      assert.ok(yealink.includes(`linekey.1.label = ${extension}`));
      assert.ok(yealink.includes("account.1.user_name = gencredabc123"));
      const audiocodes = audiocodesPhoneConfig(assigned);
      assert.ok(audiocodes.includes(`voip/line/0/description=${extension}`));
      assert.ok(audiocodes.includes("voip/line/0/id=gencredabc123"));
      for (const config of [poly,yealink,audiocodes]) assert.ok(!config.includes("+15551234567"));
    }
    assert.match(polycomRegistrationConfig({...phone,extension:null}),/reg\.1\.label="Desk 12"/);
  });

  it("derives Telnyx SIP connection usernames with phone prefix before the MAC", () => {
    assert.strictEqual(phoneConnectionUserName("00:04:F2:AB:CD:EF"), "phone0004F2ABCDEF");
    assert.strictEqual(phoneConnectionUserName("805ec0123456"), "phone805EC0123456");
    assert.strictEqual(phoneConnectionUserName("hp0004F2ABCDEF"), "phone0004F2ABCDEF");
    assert.strictEqual(phoneConnectionUserName("phone0004F2ABCDEF"), "phone0004F2ABCDEF");
    assert.strictEqual(phoneConnectionName("00:04:F2:AB:CD:EF"), "phone_0004F2ABCDEF");
    assert.throws(() => phoneConnectionUserName("not-a-mac"), /Valid phone MAC is required/);
  });

  it("repairs Telnyx-created SIP connections when the create response loses the phone prefix", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.TELNYX_API_KEY;
    const originalOutboundProfile = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === "PATCH") {
        return Response.json({ data: { id: "cc-123", connection_name: "phone_0004F2000001", user_name: "phone0004F2000001" } });
      }
      return Response.json({ data: { id: "cc-123", connection_name: "phone_0004F2000001", user_name: "0004F2000001" } });
    };
    process.env.TELNYX_API_KEY = "test-key";
    process.env.TELNYX_OUTBOUND_VOICE_PROFILE = "ovp-123";
    try {
      const created = await createPhoneSipConnection({ mac: "00:04:F2:00:00:01", vendor: "polycom", model: "VVX 310", assignedPhoneNumber: "+17205550102" });
      assert.strictEqual(created.sip_username, "phone0004F2000001");
      assert.strictEqual(calls.length, 2);
      const createBody = JSON.parse(calls[0].options.body);
      assert.strictEqual(createBody.user_name, "phone0004F2000001");
      assert.strictEqual(createBody.inbound.ani_number_format, "+E.164");
      assert.strictEqual(createBody.inbound.dnis_number_format, "+e164");
      assert.deepEqual(createBody.inbound.codecs, ["G711U", "G711A", "G722", "G729"]);
      assert.equal(createBody.outbound.ani_override, undefined, "The device DID must never override per-call From");
      assert.equal(createBody.outbound.ani_override_type, undefined);
      assert.equal(createBody.outbound.call_parking_enabled, true);
      assert.strictEqual(calls[1].options.method, "PATCH");
      assert.strictEqual(JSON.parse(calls[1].options.body).user_name, "phone0004F2000001");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
      if (originalOutboundProfile === undefined) delete process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
      else process.env.TELNYX_OUTBOUND_VOICE_PROFILE = originalOutboundProfile;
    }
  });

  it("clears Telnyx SIP connection outbound caller ID with a blank override", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.TELNYX_API_KEY;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return Response.json({ data: { id: "cc-123" } });
    };
    process.env.TELNYX_API_KEY = "test-key";
    try {
      await clearPhoneSipConnectionCallerId({ connectionId: "cc-123" });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].options.method, "PATCH");
      assert.deepStrictEqual(JSON.parse(calls[0].options.body).outbound, {
        ani_override: "",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.TELNYX_API_KEY;
      else process.env.TELNYX_API_KEY = originalApiKey;
    }
  });

  it("resolves provisioning filenames to vendor and kind", () => {
    assert.deepStrictEqual(resolveProvisioningRequest("y000000000000.cfg"), { vendor: "yealink", kind: "common", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("y000000000066.cfg"), { vendor: "yealink", kind: "common", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("0004f2abcdef-reg.cfg"), { vendor: "polycom", kind: "registration", mac: "0004f2abcdef" });
    assert.deepStrictEqual(resolveProvisioningRequest("0004f2abcdef-phone.cfg"), { vendor: "polycom", kind: "phone", mac: "0004f2abcdef" });
    assert.deepStrictEqual(resolveProvisioningRequest("000000000000.cfg"), { vendor: "polycom", kind: "default-master", mac: null });
    assert.deepStrictEqual(resolveProvisioningRequest("805ec0123456.cfg"), { vendor: null, kind: "mac-config", mac: "805ec0123456" });
    assert.strictEqual(resolveProvisioningRequest("evil.php"), null);
    assert.strictEqual(resolveProvisioningRequest("../../etc/passwd"), null);
  });

  it("generates Polycom master and registration XML with Telnyx registration", () => {
    const master = polycomMasterConfig();
    assert.match(master, /CONFIG_FILES="\[PHONE_MAC_ADDRESS\]-reg\.cfg"/);
    const reg = polycomRegistrationConfig(phone, { baseUrl: "https://cc.example.com", eventToken: "device-event-token" });
    assert.match(reg, /reg\.1\.address="gencredabc123"/);
    assert.match(reg, /reg\.1\.auth\.userId="gencredabc123"/);
    assert.match(reg, /reg\.1\.auth\.password="secretpw"/);
    assert.match(reg, /reg\.1\.server\.1\.address="sip\.telnyx\.com"/);
    assert.match(reg, /reg\.1\.server\.1\.transport="UDPOnly"/);
    assert.match(reg, /apps\.restapi\.enabled="1"/);
    assert.match(reg, /apps\.telNotification\.URL=/);
    assert.match(reg, /device\.auth\.localAdminPassword="newadminpw"/);
    assert.match(reg, /prov\.polling\.enabled="1"/);
    assert.match(reg, /reg\.1\.lineKeys="3"/);
    assert.match(reg, /time\.example\.com/);
    assert.match(reg, /device\.prov\.upgradeServer/);
    assert.match(reg, /log\.server\.address="10\.0\.0\.10"/);
  });

  it("generates Yealink cfg with version header, account and action URLs", () => {
    const common = yealinkCommonConfig({ baseUrl: "https://cc.example.com" });
    assert.match(common, /^#!version:1\.0\.0\.1/);
    assert.match(common, /static\.auto_provision\.server\.url = https:\/\/cc\.example\.com\/api\/provisioning\//);
    const cfg = yealinkPhoneConfig({ ...phone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(cfg, /^#!version:1\.0\.0\.1/);
    assert.match(cfg, /account\.1\.auth_name = gencredabc123/);
    assert.match(cfg, /account\.1\.user_name = gencredabc123/);
    assert.match(cfg, /account\.1\.password = secretpw/);
    assert.match(cfg, /account\.1\.sip_server\.1\.address = sip\.telnyx\.com/);
    assert.match(cfg, /features\.action_uri\.enable = 0/);
    assert.match(cfg, /action_url\.incoming_call = /);
    assert.match(cfg, /action_url\.call_terminated = /);
    assert.match(cfg, /static\.security\.user_password = admin:newadminpw/);
    assert.match(cfg, /linekey\.1\.label = Desk 12/);
    assert.match(cfg, /features\.config_dsskey_length = 3/);
    assert.match(cfg, /local_time\.ntp_server1 = time\.example\.com/);
    assert.match(cfg, /firmware\.url = https:\/\/firmware\.example\.com\/poly\//);
    assert.match(cfg, /custom_config\.url = https:\/\/cfg\.example\.com\/extra\.cfg/);
    assert.match(cfg, /syslog\.server = 10\.0\.0\.10/);
  });

  it("keeps Yealink common provisioning URLs on the request host instead of public webhook host", async () => {
    const route = await src("app/api/provisioning/[filename]/route.js");
    assert.match(route, /function resolveProvisioningBaseUrl\(request\)/);
    assert.match(route, /x-forwarded-host/);
    assert.match(route, /x-forwarded-proto/);
    assert.match(route, /yealinkCommonConfig\(\{ baseUrl: resolveProvisioningBaseUrl\(request\) \}\)/);
  });

  it("generates AudioCodes INI cfg with line 0 and provisioning persistence", () => {
    const cfg = audiocodesPhoneConfig({ ...phone, vendor: "audiocodes", model: "445HD" }, { baseUrl: "https://cc.example.com" });
    assert.match(cfg, /system\/type=445HD/);
    assert.match(cfg, /voip\/line\/0\/auth_name=gencredabc123/);
    assert.match(cfg, /voip\/line\/0\/auth_password=secretpw/);
    assert.match(cfg, /voip\/signalling\/sip\/proxy_address=sip\.telnyx\.com/);
    assert.ok(cfg.includes(`provisioning/configuration/url=https://cc.example.com/api/provisioning/${phone.mac}.cfg`));
    assert.match(cfg, /voip\/services\/notify\/check_sync\/force_reboot_enabled=0/);
    assert.match(cfg, /voip\/auto_answer\/enabled=1/);
    assert.match(cfg, /system\/password=newadminpw/);
    assert.match(cfg, /provisioning\/firmware\/url=https:\/\/firmware\.example\.com\/poly\//);
    assert.match(cfg, /system\/ntp\/primary_server_address=time\.example\.com/);
    assert.match(cfg, /system\/syslog\/server_address=10\.0\.0\.10/);
  });

  it("uses the Telnyx credential username as SIP line identity for registration", () => {
    const numberedPhone = { ...phone, assigned_phone_number: "+15551234567", sip_username: "0004F2ABCDEF" };

    const poly = polycomRegistrationConfig(numberedPhone, { baseUrl: "https://cc.example.com" });
    assert.match(poly, /reg\.1\.address="0004F2ABCDEF"/);
    assert.match(poly, /reg\.1\.auth\.userId="0004F2ABCDEF"/);

    const yealink = yealinkPhoneConfig({ ...numberedPhone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(yealink, /account\.1\.user_name = 0004F2ABCDEF/);
    assert.match(yealink, /account\.1\.auth_name = 0004F2ABCDEF/);

    const audiocodes = audiocodesPhoneConfig({ ...numberedPhone, vendor: "audiocodes" }, { baseUrl: "https://cc.example.com" });
    assert.match(audiocodes, /voip\/line\/0\/id=0004F2ABCDEF/);
    assert.match(audiocodes, /voip\/line\/0\/auth_name=0004F2ABCDEF/);
  });

  it("uses Line Label for phone display text without replacing SIP line identity", () => {
    const namedPhone = {
      ...phone,
      phone_name: "Reception inventory name",
      label: "Front Desk Line",
      assigned_phone_number: "+15551234567",
      sip_username: "phone0004F2ABCDEF",
    };

    const poly = polycomRegistrationConfig(namedPhone, { baseUrl: "https://cc.example.com" });
    assert.match(poly, /reg\.1\.address="phone0004F2ABCDEF"/);
    assert.match(poly, /reg\.1\.label="Front Desk Line"/);
    assert.match(poly, /reg\.1\.displayName="Front Desk Line"/);
    assert.doesNotMatch(poly, /Reception inventory name/);

    const yealink = yealinkPhoneConfig({ ...namedPhone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(yealink, /account\.1\.user_name = phone0004F2ABCDEF/);
    assert.match(yealink, /account\.1\.label = Front Desk Line/);
    assert.match(yealink, /linekey\.1\.label = Front Desk Line/);
    assert.doesNotMatch(yealink, /Reception inventory name/);

    const audiocodes = audiocodesPhoneConfig({ ...namedPhone, vendor: "audiocodes" }, { baseUrl: "https://cc.example.com" });
    assert.match(audiocodes, /voip\/line\/0\/id=phone0004F2ABCDEF/);
    assert.match(audiocodes, /voip\/line\/0\/description=Front Desk Line/);
    assert.doesNotMatch(audiocodes, /Reception inventory name/);
  });

  it("writes selected NTP timezone offset settings into vendor configs", () => {
    const warsawPhone = { ...phone, settings: { ...phone.settings, ntp_timezone: "Europe/Warsaw", timezone_discovery: false } };
    const warsawOffset = currentOffsetSeconds("Europe/Warsaw");
    const warsawYealinkOffset = `${warsawOffset >= 0 ? "+" : ""}${warsawOffset / 3600}`;

    const poly = polycomRegistrationConfig(warsawPhone, { baseUrl: "https://cc.example.com" });
    assert.match(poly, new RegExp(`tcpIpApp\\.sntp\\.gmtOffset="${warsawOffset}"`));
    assert.match(poly, new RegExp(`device\\.sntp\\.gmtOffset="${warsawOffset}"`));

    const yealink = yealinkPhoneConfig({ ...warsawPhone, vendor: "yealink" }, { baseUrl: "https://cc.example.com" });
    assert.match(yealink, /local_time\.dhcp_time = 0/);
    assert.match(yealink, new RegExp(`local_time\\.time_zone = \\${warsawYealinkOffset}`));

    const audiocodes = audiocodesPhoneConfig({ ...warsawPhone, vendor: "audiocodes" }, { baseUrl: "https://cc.example.com" });
    assert.ok(audiocodes.includes(`system/ntp/gmt_offset=+${String(warsawOffset / 3600).padStart(2,"0")}:00`));
    assert.match(audiocodes, /network\/lan\/dhcp\/ntp\/gmt_offset\/enabled=0/);
  });

  it("builds per-vendor config from the request kind", () => {
    const polyMaster = buildConfigForPhone(phone, "mac-config", {});
    assert.match(polyMaster.body, /APPLICATION/);
    assert.strictEqual(polyMaster.contentType, "text/xml");
    const polyReg = buildConfigForPhone(phone, "registration", {});
    assert.match(polyReg.body, /reg\.1\.address/);
    const polyPhone = buildConfigForPhone(phone, "phone", {});
    assert.strictEqual(polyPhone, null);
    const yl = buildConfigForPhone({ ...phone, vendor: "yealink" }, "mac-config", {});
    assert.match(yl.body, /account\.1\.enable = 1/);
    assert.strictEqual(yl.contentType, "text/plain");
    const ac = buildConfigForPhone({ ...phone, vendor: "audiocodes" }, "mac-config", {});
    assert.match(ac.body, /voip\/line\/0\/enabled=1/);
    assert.strictEqual(buildConfigForPhone({ ...phone, vendor: "cisco" }, "mac-config", {}), null);
  });

  it("escapes XML special characters in Polycom config", () => {
    const reg = polycomRegistrationConfig({ ...phone, label: `A"B<C>&D`, sip_password: `p"w&` }, {});
    assert.match(reg, /A&quot;B&lt;C&gt;&amp;D/);
    assert.match(reg, /p&quot;w&amp;/);
    assert.doesNotMatch(reg, /reg\.1\.label="A"B/);
  });

  it("detects vendor from provisioning user agents", () => {
    assert.strictEqual(vendorFromUserAgent("PolycomVVX-VVX_450-UA/6.4.0"), "polycom");
    assert.strictEqual(vendorFromUserAgent("Yealink SIP-T46S 66.86.0.15 805ec0123456"), "yealink");
    assert.strictEqual(vendorFromUserAgent("AUDC-IPPhone-445HD_UC_3.4.8/1.0"), "audiocodes");
    assert.strictEqual(vendorFromUserAgent("curl/8.0"), null);
  });

  it("schema defines hp_phones and hp_provisioning_events", async () => {
    const code = await src("lib/postgres-schema.mjs");
    assert.match(code, /CREATE TABLE IF NOT EXISTS hp_phones/);
    assert.match(code, /CREATE TABLE IF NOT EXISTS hp_provisioning_events/);
    assert.match(code, /hp_phones_updated_at_trigger/);
    assert.match(code, /idx_hp_phones_mac/);
  });

  it("admin API supports phone CRUD with SIP connection auto-create", async () => {
    const listCode = await src("app/api/admin/phones-provisioning/phones/route.js");
    assert.match(listCode, /export const GET = withPermission\(/);
    assert.match(listCode, /export const POST = withPermission\(/);
    assert.match(listCode, /createPhoneSipConnection/);
    assert.match(listCode, /TELNYX_PHONE_ADMIN_PASSWORD/);
    assert.match(listCode, /TELNYX_OUTBOUND_VOICE_PROFILE/);
    assert.match(listCode, /withPermission\("phones:/);
    const itemCode = await src("app/api/admin/phones-provisioning/phones/[id]/route.js");
    assert.match(itemCode, /export const PUT = withPermission\(/);
    assert.match(itemCode, /export const DELETE = withPermission\(/);
    assert.match(itemCode, /deletePhoneSipConnection/);
    assert.match(itemCode, /const \{ id \} = await params/);
  });

  it("public provisioning endpoint serves configs only for inventoried phones", async () => {
    const code = await src("app/api/provisioning/[filename]/route.js");
    assert.match(code, /resolveProvisioningRequest/);
    assert.match(code, /SELECT id, mac, vendor, model, phone_name, label, assigned_phone_number_id, assigned_phone_number, sip_username/);
    assert.match(code, /buildConfigForPhone\(phone/);
    assert.match(code, /unknown_phone_request/);
    assert.match(code, /config_served/);
    assert.match(code, /const kind = resolved\.kind/);
    assert.doesNotMatch(code, /resolved\.kind === "registration" \? "registration" : "mac-config"/);
    assert.match(code, /last_seen_at = NOW\(\)/);
    assert.match(code, /provisioning_state = 'disabled'|provisioning_state === "disabled"/);
    // No auth gate — phones cannot authenticate; security via MAC allow-list
    assert.doesNotMatch(code, /requireAdmin/);
  });

  it("phone event sink logs vendor events with MAC correlation", async () => {
    const code = await src("app/api/provisioning/events/[vendor]/route.js");
    // Vendor event sink stays public (device identity, listed in lib/authz/route-exemptions.mjs).
    assert.match(code, /export async function GET/);
    assert.match(code, /export async function POST/);
    assert.match(code, /phone_event_/);
    assert.match(code, /normalizeMac/);
  });

  it("page uses 3-panel layout with phones, bridges, logs and settings sections", async () => {
    const code = await src("app/(portal)/admin/phones-provisioning/page.jsx") + await src("lib/hardphones/model-catalog.mjs");
    assert.match(code, /Context settings/);
    assert.match(code, /SystemSectionPage/);
    assert.match(code, /TabsList/);
    assert.match(code, /380px/);
    assert.doesNotMatch(code, /id: "dashboard"/);
    assert.match(code, /Phones/);
    assert.match(code, /Bridges/);
    assert.match(code, /Logs/);
    assert.match(code, /id: "logs"[\s\S]*label: "Logs"/);
    assert.match(code, /id: "bridges"[\s\S]*id: "logs"[\s\S]*id: "settings"/);
    assert.match(code, /MAC address/);
    assert.match(code, /disabled=\{!draftValid \|\| saving \|\| \(!selectedPhone && \(!hardphoneConfig\.phoneAdminPasswordConfigured \|\| !hardphoneConfig\.outboundVoiceProfileConfigured\)\)\}/);
    assert.match(code, /phoneDraftValid/);
    assert.match(code, /PHONE_MODEL_CATALOG/);
    assert.match(code, /PhoneModelPreview/);
    assert.match(code, /Full manufacturer documentation/);
    assert.match(code, /\/images\/hardphones\/poly-vvx-450\.png/);
    assert.match(code, /VVX 101/);
    assert.match(code, /Edge E550/);
    assert.match(code, /420HD/);
    assert.match(code, /T22P/);
    assert.match(code, /T27P/);
    assert.match(code, /T19P E2/);
    assert.match(code, /https:\/\/www\.yealink\.com\/en\/products_list_18\.html/);
    assert.match(code, /https:\/\/www\.yealink\.com\/en\/product-detail\/ip-phone-t46u/);
    assert.match(code, /Context settings view/);
    assert.match(code, /Dynamic reload/);
    assert.match(code, /Automatic firmware updates/);
    assert.match(code, /Reboot selected/);
    assert.match(code, /\/phones\/reboot/);
    assert.doesNotMatch(code, /Genesys managed phone matrix/);
    assert.doesNotMatch(code, /help\.genesys\.cloud/);
    assert.match(code, /settings\.cti_mode = "telnyx"/);
  });

  it("moves provisioning events to a dedicated paged logs section", async () => {
    const page = await src("app/(portal)/admin/phones-provisioning/page.jsx");
    const dashboardView = page.slice(page.indexOf("function DashboardView"), page.indexOf("function PhonesListView"));
    assert.doesNotMatch(dashboardView, /Provisioning activity/);
    assert.match(page, /function LogsView/);
    assert.match(page, /setLogDays/);
    assert.match(page, /setLogPageSize/);
    assert.match(page, /\[10, 25, 50\]\.map/);
    assert.match(page, /Accordion/);
    assert.match(page, /AccordionContent/);
    assert.match(page, /Phone name/);
    assert.match(page, /MAC address/);
    assert.match(page, /Event type/);
    assert.match(page, /event\.detail/);
    assert.match(page, /fetch\(`\$\{API\}\/logs\?/);


  });

  it("bundles exact model artwork without the replaced inventory photos", async () => {
    const base = new URL("..", import.meta.url).pathname;
    const files = readdirSync(`${base}public/images/hardphones`).filter((name) => /\.(png|jpe?g|webp)$/i.test(name));
    const page = await src("lib/hardphones/model-catalog.mjs");

    [
      "yealink-t31p.png",
      "yealink-t33g.png",
      "yealink-t43u.png",
      "yealink-t46u.png",
      "yealink-t48u.png",
      "yealink-t53w.png",
      "yealink-t54w.png",
      "yealink-t57w.png",
      "yealink-t58w.png",
      "audiocodes-405hd.png",
      "audiocodes-425hd.png",
      "audiocodes-430hd.png",
      "audiocodes-c430hd.png",
      "audiocodes-445hd.png",
      "audiocodes-450hd.png",
      "audiocodes-c450hd.png",
    ].forEach((file) => assert.ok(files.includes(file), `missing ${file}`));

    const studio = readdirSync(`${base}public/images/hardphones/studio-v2/source`);
    for (const file of ["audiocodes-420hd.png", "audiocodes-440hd.png", "poly-vvx-300.png", "yealink-t22p.png"]) {
      assert.ok(studio.includes(file), `missing studio artwork ${file}`);
      assert.ok(!files.includes(file), `obsolete photograph ${file}`);
    }

    assert.match(page, /T54W[\s\S]*yealink-t54w\.png/);
    assert.match(page, /T57W[\s\S]*yealink-t57w\.png/);
    assert.match(page, /420HD[\s\S]*audiocodes-420hd\.png/);
    assert.match(page, /425HD[\s\S]*audiocodes-425hd\.png/);
    assert.match(page, /430HD[\s\S]*audiocodes-430hd\.png/);
    assert.match(page, /440HD[\s\S]*audiocodes-440hd\.png/);
    assert.match(page, /450HD[\s\S]*audiocodes-450hd\.png/);
    assert.match(page, /C450HD[\s\S]*audiocodes-c450hd\.png/);
    assert.doesNotMatch(page, /\["T53", "T53W", "T52S", "T54S", "T54W"\]\.includes\(model\)\) return "\/images\/hardphones\/yealink-t53w\.png"/);
    assert.ok(files.length >= 30);
  });

  it("menu replaces CTI Testing with Phones Provisioning", async () => {
    const code = await src("components/admin/SystemSectionNav.jsx");
    assert.match(code, /Phones Provisioning/);
    assert.match(code, /\/admin\/phones-provisioning/);
    assert.doesNotMatch(code, /cti-testing/);
  });

  it("legacy CTI testing module is removed", () => {
    const base = new URL("..", import.meta.url).pathname;
    assert.strictEqual(existsSync(`${base}app/(portal)/admin/cti-testing`), false);
    assert.strictEqual(existsSync(`${base}app/api/voice/cti`), false);
    assert.strictEqual(existsSync(`${base}lib/cti`), false);
  });
});
