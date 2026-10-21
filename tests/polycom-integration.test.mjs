import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolycomDriver } from "../lib/hardphones/drivers/polycom.mjs";
import { authorizeProvisioning, authorizeProvisioningEvent, provisioningCredentials, provisioningEventToken, polycomBootstrapConfig, polycomBootstrapParameters } from "../lib/hardphones/provisioning-access.mjs";
import { buildConfigForPhone } from "../lib/hardphones/config-generators.mjs";
import { configurePolycomProvisioning, verifyPolycomProvisioning, synchronizePolycomLineLabel } from "../lib/hardphones/polycom-provisioning.mjs";

const phone = { id: "phone-a", mac: "0004f2abcdef", vendor: "polycom", sip_username: "station-a", settings: {} };
const enrollment = { generation: "generation-a", base_url: "https://cc.example.com", downloaded_at: new Date().toISOString() };
process.env.HARDPHONE_PROVISIONING_SECRET = "test-only-server-key-never-used-in-production";
const success = data => ({ ok: true, data: { Status: "2000", data } });

test("device credentials are bound to device, generation and purpose", () => {
  const credential = provisioningCredentials(phone, enrollment);
  assert.match(credential.password, /^[0-9a-f]{32}$/, "Use the credential format certified on VVX 5.9");
  const basic = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  assert.equal(authorizeProvisioning(basic, phone, enrollment), true);
  for (const invalid of [null, "Basic broken", "Bearer wrong", `Basic ${Buffer.from(`${phone.mac}:wrong`).toString("base64")}`]) assert.equal(authorizeProvisioning(invalid, phone, enrollment), false);
  assert.equal(authorizeProvisioning(basic, { ...phone, id: "phone-b" }, enrollment), false);
  assert.equal(authorizeProvisioning(basic, phone, { ...enrollment, generation: "rotated" }), false);
  assert.equal(authorizeProvisioning(basic, phone, null), false);
  assert.equal(authorizeProvisioningEvent(credential.password, phone, enrollment), false);
  assert.equal(authorizeProvisioningEvent(`Basic ${Buffer.from(`${phone.mac}:${provisioningEventToken(phone, enrollment)}`).toString("base64")}`, phone, enrollment), true);
});

test("bootstrap uses HTTPS and separate provisioning credentials; reserved override is not served", () => {
  const xml = polycomBootstrapConfig(phone, enrollment);
  assert.match(xml, /device.prov.serverType="HTTPS"/);
  assert.match(xml, /apps.restapi.enabled="1"/);
  assert.doesNotMatch(xml, /reg.1.auth.password/);
  assert.equal(buildConfigForPhone(phone, "phone"), null);
  assert.doesNotMatch(buildConfigForPhone(phone, "mac-config").body, /-phone.cfg/);
  const unauthenticatedEvents = buildConfigForPhone(phone, "registration", { baseUrl: enrollment.base_url });
  assert.doesNotMatch(unauthenticatedEvents.body, /telNotification.URL/);
  const authenticatedEvents = buildConfigForPhone(phone, "registration", { baseUrl: enrollment.base_url, eventToken: "event-proof" });
  assert.match(authenticatedEvents.body, /0004f2abcdef:event-proof@cc.example.com/);
  assert.doesNotMatch(authenticatedEvents.body, /token=/);
});

test("idle UCS 4007 is a healthy status but cannot be answered", async () => {
  const driver = createPolycomDriver(async (_phone, _method, path) => path.endsWith("callStatus")
    ? { ok: false, polyStatus: "4007" } : success([{ LineNumber: "1", RegistrationStatus: "registered" }]));
  assert.equal((await driver.status(phone)).ok, true);
  assert.equal((await driver.answer(phone)).reason, "no_active_call");
});

test("status never issues concurrent REST requests to UCS", async () => {
  let running = 0;
  const driver = createPolycomDriver(async () => {
    assert.equal(running++, 0, "UCS rejects parallel requests");
    await new Promise(resolve => setTimeout(resolve, 2));
    running--;
    return success([]);
  });
  assert.equal((await driver.status(phone)).ok, true);
});

test("v2 call status falls back only when unsupported, never on an uncertain read", async () => {
  for (const [failure, expectedCalls] of [[{ ok: false, httpStatus: 404 }, 2], [{ ok: false, reason: "phone_unreachable" }, 1]]) {
    const paths = [];
    const driver = createPolycomDriver(async (_p, _m, path) => {
      paths.push(path);
      return path.includes("/v2/") ? failure : { ok: false, polyStatus: "4007" };
    });
    await driver.answer(phone);
    assert.equal(paths.length, expectedCalls);
  }
});

test("ambiguous calls require an explicit reference and never choose the first call", async () => {
  const requests = [];
  const driver = createPolycomDriver(async (_p, method, path, body) => {
    requests.push({ method, path, body });
    return method === "GET" ? success([{ Ref: "a", CallState: "Connected" }, { Ref: "b", CallState: "Held" }]) : success();
  });
  assert.equal((await driver.hangup(phone)).reason, "ambiguous_call");
  assert.equal(requests.filter(r => r.method === "POST").length, 0);
  assert.equal((await driver.hangup(phone, { callRef: "b" })).ok, true);
  assert.deepEqual(requests.at(-1).body, { data: { Ref: "b" } });
});

test("CTI validates destinations/DTMF and protects held calls", async () => {
  let mutations = 0;
  const driver = createPolycomDriver(async (_p, method) => {
    if (method === "POST") mutations++;
    return success([{ Ref: "a", CallState: "Held" }]);
  });
  assert.equal((await driver.dial(phone, undefined)).reason, "invalid_destination");
  assert.equal((await driver.dial(phone, "123\r\nHeader: injected")).reason, "invalid_destination");
  assert.equal((await driver.sendDtmf(phone, "x")).reason, "invalid_dtmf");
  assert.equal((await driver.sendDtmf(phone, "12#")).reason, "dtmf_not_allowed_while_held");
  assert.equal((await driver.mute(phone)).reason, "mute_not_allowed_while_held");
  assert.equal(mutations, 0);
});

test("explicit SIP destinations use SIP dialing without a duplicate scheme", async () => {
  const sent = [];
  const driver = createPolycomDriver(async (_p, _m, _path, body) => { sent.push(body.data); return success(); });
  await driver.dial(phone, "sip:test@example.com");
  await driver.dial(phone, "+12025550100");
  assert.deepEqual(sent, [{ Dest: "test@example.com", Line: "1", Type: "SIP" }, { Dest: "+12025550100", Line: "1" }]);
});

test("an uncertain hangup is never repeated", async () => {
  const calls = [];
  const driver = createPolycomDriver(async (_p, method, path) => {
    calls.push(path);
    return method === "GET" ? success([{ Ref: "a", CallState: "Held" }]) : { ok: false, uncertain: true, polyStatus: "4003" };
  });
  assert.equal((await driver.hangup(phone)).uncertain, true);
  assert.equal(calls.length, 2);
});

function fixture({ registered = true, downloaded = true, matches = true, mac = phone.mac, call = null, extension = null, displayLabel = extension || "Telnyx" } = {}) {
  const writes = [];
  const pool = { query: async (sql, params) => {
    if (sql.startsWith("SELECT * FROM hp_device")) return { rows: [{ ...enrollment, downloaded_at: downloaded ? enrollment.downloaded_at : null }] };
    if (sql.startsWith("SELECT a.number")) return {rows:extension ? [{number:extension}] : []};
    writes.push({ sql, params }); return { rows: [] };
  } };
  const driver = {
    deviceInfo: async () => success({ MACAddress: mac, ModelNumber: "VVX 300", FirmwareRelease: "5.9.8.5760" }),
    status: async () => ({ ok: true, call, line: [{ LineNumber: "1", RegistrationStatus: registered ? "registered" : "unregistered" }] }),
    getConfig: async () => success(Object.fromEntries(Object.entries({
      "reg.1.address": matches ? phone.sip_username : "other-account", "reg.1.auth.userId": phone.sip_username,
      "reg.1.label": displayLabel, "reg.1.displayName": displayLabel,
      "reg.1.server.1.address": "sip.telnyx.com", "apps.restapi.enabled": "1", "device.prov.serverName": polycomBootstrapParameters(phone, enrollment)["device.prov.serverName"],
    }).map(([key, value]) => [key, { Value: value, Source: "config" }]))),
    setConfig: async () => { throw new Error("Unexpected configuration mutation"); },
  };
  return { pool, driver, writes };
}

test("verification requires authenticated download, applied identity and SIP registration", async () => {
  for (const [options, expected] of [[{}, true], [{ registered: false }, false], [{ downloaded: false }, false], [{ matches: false }, false]]) {
    const { pool, driver } = fixture(options);
    assert.equal((await verifyPolycomProvisioning(pool, phone, { driver })).verified, expected);
  }
});

test("verification checks the current extension label, including reassignment and removal", async () => {
  for (const [options, expected] of [
    [{extension:"1001"},true], [{extension:"1002",displayLabel:"1001"},false],
    [{extension:null,displayLabel:"1001"},false], [{extension:null},true],
  ]) {
    const {pool,driver}=fixture(options);
    assert.equal((await verifyPolycomProvisioning(pool,phone,{driver})).verified,expected);
  }
});

test("configuration refuses a different physical device and an active call", async () => {
  for (const [options, reason] of [[{ mac: "001122334455" }, "device_mac_mismatch"], [{ call: [{ Ref: "a" }] }, "phone_has_active_call"]]) {
    const { pool, driver, writes } = fixture(options);
    assert.equal((await configurePolycomProvisioning(pool, phone, { driver })).reason, reason);
    assert.equal(writes.filter(row => /UPDATE|INSERT/.test(row.sql)).length, 0);
  }
});

test("legacy local display overrides follow the extension without changing SIP identity", async () => {
  const {pool,driver}=fixture({extension:"1001"});
  const changed=[];
  driver.getConfig=async()=>success({
    "reg.1.label":{Value:"old-sip-identity",Source:"local"},
    "reg.1.displayName":{Value:"old-sip-identity",Source:"local"},
  });
  driver.setConfig=async(_phone,parameters)=>{changed.push(parameters);return success();};
  assert.equal((await synchronizePolycomLineLabel(pool,phone,{driver})).ok,true);
  assert.deepEqual(changed,[{"reg.1.label":"1001","reg.1.displayName":"1001"}]);
});

test("provisioning-file labels stay managed by the file and active calls block legacy label updates", async () => {
  const ordinary=fixture({extension:"1001",displayLabel:"old"});
  assert.equal((await synchronizePolycomLineLabel(ordinary.pool,phone,{driver:ordinary.driver})).ok,true);
  const active=fixture({call:[{Ref:"ongoing"}]});
  assert.equal((await synchronizePolycomLineLabel(active.pool,phone,{driver:active.driver})).reason,"phone_has_active_call");
});
