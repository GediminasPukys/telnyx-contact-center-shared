import test from "node:test";
import assert from "node:assert/strict";
import { audioCodesSession, inspectAudioCodes, parseAudioCodesStatus, parseAudioCodesConfiguration, configureAudioCodesProvisioning } from "../lib/hardphones/audiocodes-provisioning.mjs";
import { readDeviceForm, deviceWebRequest } from "../lib/hardphones/device-web.mjs";
import { audiocodesPhoneConfig } from "../lib/hardphones/config-generators.mjs";
import { audiocodesBootstrapConfig, provisioningCredentials, authorizeProvisioning } from "../lib/hardphones/provisioning-access.mjs";

const phone = { id: "fixture-phone", mac: "00908f000001", model: "420HD", vendor: "audiocodes",
  ip_address: "192.0.2.10", admin_password: "fixture-admin", sip_username: "phone00908F000001", sip_password: "fixture-sip",
  extension: "1002", settings: { ntp_timezone: "Europe/Warsaw" } };
const info = `<table><tr><td>Model Name</td><td>&nbsp;420HD</td></tr>
  <tr><td>Firmware Version</td><td>2.2.16.643</td></tr><tr><td>MAC Address</td><td>00:90:8F:00:00:01</td></tr></table>`;
const status = `<Status><Line id="0"><PhoneState>On Hook</PhoneState><SipStatus>Registered</SipStatus><SipRegSrv>sip.telnyx.com</SipRegSrv></Line></Status>`;

test("desktop bridge provisioning survives periodic reload and rejects malformed proxy addresses", () => {
  const desktop={...phone,settings:{cti_mode:"desktop_bridge",sip_controller_host:"192.168.1.20",sip_controller_port:5070}};
  const cfg=audiocodesPhoneConfig(desktop);
  assert.match(cfg,/sip_outbound_proxy\/addr=192\.168\.1\.20/);
  assert.match(cfg,/sip_outbound_proxy\/enabled=1/);
  assert.match(cfg,/voip\/dialing\/automatic_disconnect=1/);
  assert.match(cfg,/voip\/signalling\/sip\/registration_failed_timeout=15/);
  assert.doesNotMatch(audiocodesPhoneConfig(phone),/registration_failed_timeout=15/);
  assert.throws(()=>audiocodesPhoneConfig({...desktop,settings:{...desktop.settings,sip_controller_host:"999.1.1.1\ninjected=1"}}),/invalid_desktop/);
  assert.throws(()=>audiocodesPhoneConfig({...desktop,model:"450HD"}),/invalid_desktop/);
});

test("AudioCodes generator uses documented 2.2.16 keys, extension display and separate SIP identity", () => {
  const cfg = audiocodesPhoneConfig(phone, { baseUrl: "https://cc.example.test", credential: { username: phone.mac, password: "fixture-config" } });
  for (const expected of ["voip/signalling/sip/use_proxy_ip_port_for_registrar=1", "voip/signalling/sip/proxy_timeout=600",
    "system/ntp/primary_server_address=pool.ntp.org", "voip/line/0/description=1002",
    `voip/line/0/id=${phone.sip_username}`, `provisioning/configuration/url=https://cc.example.test/api/provisioning/${phone.mac}.cfg`,
    "provisioning/configuration/http_auth/password=fixture-config"]) assert.ok(cfg.includes(expected), expected);
  assert.doesNotMatch(cfg, /system\/time\/|registration_expires|system\/line_keys|use_proxy_ip_and_port_for_registration/);
  const custom = audiocodesPhoneConfig({ ...phone, model: "440HD", label: "Conference" });
  assert.match(custom, /voip\/line\/0\/extension_display=Conference/);
  assert.match(custom, /voip\/line\/0\/description=Conference/);
});

test("420HD provisioning replaces legacy G722/16000 while retaining G711 and G729", () => {
  const cfg = audiocodesPhoneConfig(phone);
  assert.match(cfg, /^voip\/codec\/codec_info\/2\/name=G722_8000$/m);
  assert.doesNotMatch(cfg, /\/name=G722$/m);
  for (const [index, name] of ["PCMU", "PCMA", "G722_8000", "G729"].entries()) {
    assert.ok(cfg.includes(`voip/codec/codec_info/${index}/name=${name}`));
    assert.ok(cfg.includes(`voip/codec/codec_info/${index}/enabled=1`));
  }
  assert.match(cfg, /^voip\/codec\/codec_info\/4\/enabled=0$/m);
  assert.doesNotMatch(audiocodesPhoneConfig({ ...phone, model: "440HD" }), /voip\/codec\/codec_info/);
});

test("AudioCodes bootstrap uses per-device provisioning authentication, never SIP credentials", () => {
  const original = process.env.HARDPHONE_PROVISIONING_SECRET;
  process.env.HARDPHONE_PROVISIONING_SECRET = "fixture-server-secret-with-at-least-32-characters";
  try {
    const enrollment = { generation: "fixture-generation", base_url: "https://cc.example.test" };
    const cfg = audiocodesBootstrapConfig(phone, enrollment), cred = provisioningCredentials(phone, enrollment);
    assert.ok(cfg.includes(`http_auth/password=${cred.password}`));
    assert.doesNotMatch(cfg, /fixture-sip|fixture-admin/);
    assert.ok(authorizeProvisioning(`Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`, phone, enrollment));
    assert.equal(authorizeProvisioning(null, phone, enrollment), false);
    assert.equal(authorizeProvisioning(`Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString("base64")}`, { ...phone, id: "another-phone" }, enrollment), false);
  } finally {
    if (original === undefined) delete process.env.HARDPHONE_PROVISIONING_SECRET;
    else process.env.HARDPHONE_PROVISIONING_SECRET = original;
  }
});

test("device form preserves unrelated values and decodes fields without executing HTML", () => {
  const form = readDeviceForm(`<form name="tftpform"><input name="CFG_URL" value="https://old/?a=1&amp;b=2">
    <input type="radio" name="mode" value="0"><input type="radio" name="mode" value="1" checked>
    <input name="Pswd" value="&#x61;&#98;"><input type="button" name="apply" value="Check now">
    <select name="ASU_METHOD"><option value="1">Dynamic</option><option value="2" selected>Static</option></select>
    <select name="untouched"><option value="x">X</option></select></form>`, "tftpform");
  assert.deepEqual(Object.fromEntries(form), { CFG_URL: "https://old/?a=1&b=2", mode: "1", Pswd: "ab", ASU_METHOD: "2", untouched: "x" });
  assert.throws(() => readDeviceForm("<html>Login</html>", "tftpform"), /unsupported_device_form/);
  assert.throws(() => deviceWebRequest({ ip_address: "example.test/path" }, "/"), /invalid_phone_ip/);
});

test("AudioCodes status distinguishes idle, active, missing and unauthenticated responses", () => {
  assert.equal(parseAudioCodesStatus(status).registered, true);
  assert.equal(parseAudioCodesStatus(status).idle, true);
  assert.equal(parseAudioCodesStatus(status.replace("On Hook", "Connected")).idle, false);
  assert.equal(parseAudioCodesStatus("<Status></Status>").idle, false);
  assert.throws(() => parseAudioCodesStatus("<html>Login</html>"), /auth_failed/);
  assert.deepEqual(parseAudioCodesConfiguration('<textarea>voip/line/0/description=Room &amp; Board\n# comment\nsystem/type=420HD</textarea>'),
    { "voip/line/0/description": "Room & Board", "system/type": "420HD" });
});

for (const mode of ["basic", "cookie"]) test(`AudioCodes ${mode} authentication verifies physical identity before configuration`, async () => {
  const calls = [];
  const request = async (target, path, options = {}) => {
    calls.push({ target, path, options });
    if (calls.length === 1) return { status: mode === "basic" ? 401 : 200, headers: mode === "basic" ? { "www-authenticate": 'Basic realm="Phone"' } : {}, raw: "", certificateFingerprint: "fixture-pin" };
    if (path === "/login.cgi") {
      const fields = new URLSearchParams(options.body);
      assert.equal(Buffer.from(fields.get("psw"), "base64").toString(), phone.admin_password);
      return { status: 200, headers: { "set-cookie": ["session=fixture; HttpOnly"] }, raw: "" };
    }
    assert.equal(target.certificate_fingerprint, "fixture-pin");
    if (mode === "basic") assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`admin:${phone.admin_password}`).toString("base64")}`);
    else assert.equal(options.headers.Cookie, "session=fixture");
    return { status: 200, headers: {}, raw: path.includes("info.htm") ? info : status };
  };
  const observed = await inspectAudioCodes(phone, null, { request });
  assert.equal(observed.model, "420HD"); assert.equal(observed.firmware, "2.2.16.643");
  assert.equal(observed.idle, true); assert.equal(observed.registered, true);
  assert.equal(calls.filter(c => c.options.method === "POST" && c.path !== "/login.cgi").length, 0);
});

test("wrong MAC and rejected credentials cannot be accepted as a provisioned phone", async () => {
  const request = async (_phone, path, options) => {
    if (!options?.headers?.Authorization) return { status: 401, headers: { "www-authenticate": "Basic" }, raw: "", certificateFingerprint: "pin" };
    return { status: 200, headers: {}, raw: info.replace("00:90:8F:00:00:01", "00:90:8F:00:00:02") };
  };
  await assert.rejects(inspectAudioCodes(phone, null, { request }), /device_mac_mismatch/);
  const session = await audioCodesSession(phone, { request: async () => ({ status: 401, headers: { "www-authenticate": "Basic" }, raw: "" }) });
  await assert.rejects(session.send("/voip_status.cgi"), /auth_failed/);
});

test("a booting web server with no device identity is not mistaken for another handset", async () => {
  const request=async (_phone,_path,options)=> !options?.headers?.Authorization
    ? {status:401,headers:{'www-authenticate':'Basic'},raw:'',certificateFingerprint:'pin'}
    : {status:200,headers:{},raw:'<html>Starting</html>'};
  await assert.rejects(inspectAudioCodes(phone,null,{request}),/device_not_ready/);
});

for (const legacy of [false, true]) test(`AudioCodes bootstrap preserves firmware fields and handles ${legacy ? "440HD file import" : "420HD case-sensitive form action"}`, async () => {
  process.env.HARDPHONE_PROVISIONING_SECRET ||= "fixture-server-secret-with-at-least-32-characters";
  const originalOrigin = process.env.HARDPHONE_PROVISIONING_BASE_URL;
  process.env.HARDPHONE_PROVISIONING_BASE_URL = "https://cc.example.test";
  const enrollment = { generation: "fixture", base_url: "https://cc.example.test" };
  const target = { ...phone, model: legacy ? "440HD" : "420HD" };
  const writes = [];
  const pool = { query: async sql => ({ rows: sql.startsWith("INSERT INTO hp_device_enrollments") ? [enrollment] : [] }) };
  const request = async (_phone, path, options = {}) => {
    if (!options.headers?.Authorization) return { status: 401, headers: { "www-authenticate": "Basic" }, raw: "" };
    let raw = "";
    if (path.endsWith("info.htm")) raw = info.replace("420HD",target.model);
    else if (path.endsWith("voip_status.cgi")) raw = status;
    else if (options.method === "POST") {
      writes.push({path,body:options.body});
      if (path.endsWith("Auto_Config.htm")) raw = '<form name="confirmform"><input name="upmode"></form>';
      else if (path.endsWith("auto_provision.htm") && new URLSearchParams(options.body).get("NOW_CFG") === "1") raw = '<script>document.tftpform.NOW_CFG.value = 2;</script>';
    } else if (path.endsWith("auto_provision.htm")) raw = `<script>document.tftpform.action="../mainform.cgi/auto_provision.htm";</script>
      <form name="tftpform"><input name="CFG_URL" value="old"><input name="FW_URL" value="https://firmware.example/preserve">
      <input name="ASU_METHOD" value="2"><input name="NOW_CFG" value="0">${legacy ? "" : '<input name="Us_Nm"><input name="Pswd">'}</form>`;
    return {status:200,headers:{},raw};
  };
  try {
    assert.equal((await configureAudioCodesProvisioning(pool,target,{request})).ok,true);
    assert.deepEqual(writes.map(x=>x.path), legacy
      ? ["/mainform.cgi/Auto_Config.htm","/mainform.cgi/Manu_Config.htm"] : ["/mainform.cgi/auto_provision.htm","/mainform.cgi/auto_provision.htm"]);
    if (!legacy) {
      const form=new URLSearchParams(writes[0].body);
      assert.equal(form.get("FW_URL"),"https://firmware.example/preserve");
      assert.equal(form.get("NOW_FW"),"0"); assert.equal(form.get("NOW_CFG"),"1");
      assert.equal(new URLSearchParams(writes[1].body).get("NOW_CFG"),"2");
    } else {
      assert.ok(Buffer.from(writes[0].body).includes(Buffer.from("provisioning/configuration/http_auth/password=")));
      assert.doesNotMatch(Buffer.from(writes[0].body).toString(),/fixture-sip/);
      assert.equal(new URLSearchParams(writes[1].body).get("upmode"),"1");
    }
  } finally {
    if (originalOrigin === undefined) delete process.env.HARDPHONE_PROVISIONING_BASE_URL;
    else process.env.HARDPHONE_PROVISIONING_BASE_URL = originalOrigin;
  }
});

test("an active physical AudioCodes call blocks all provisioning writes", async () => {
  const pool = { query: async sql => { assert.ok(!sql.startsWith("UPDATE")); return {rows:[]}; } };
  const request = async (_phone,path,options = {}) => {
    assert.notEqual(options.method,"POST");
    if (!options.headers?.Authorization) return { status:401,headers:{"www-authenticate":"Basic"},raw:"" };
    return {status:200,headers:{},raw:path.endsWith("info.htm") ? info : status.replace("On Hook","Connected")};
  };
  assert.deepEqual(await configureAudioCodesProvisioning(pool,phone,{request}),{ok:false,reason:"phone_has_active_call"});
});
