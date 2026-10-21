import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { createDeviceTlsAgent, deviceWebRequest, deviceTableText } from '../lib/hardphones/device-web.mjs';
import { setupPasswordTag, finishDesktopPhone } from '../lib/telephony/desktop-enrollment.mjs';

test('self-signed TLS pins block credentials before HTTP on certificate mismatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'handset-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=handset-fixture', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'));
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const received = [];
  const server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    received.push(req.headers); res.end('ok');
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async pin => {
    const agent = createDeviceTlsAgent({ host: '127.0.0.1', port: server.address().port, fingerprint: pin });
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get({ host: '127.0.0.1', port: server.address().port, agent,
          headers: { Authorization: 'Basic synthetic-test-only' } }, res => {
          res.resume(); res.on('end', resolve);
        });
        req.on('error', reject);
      });
    } finally { agent.destroy(); }
  };
  await assert.rejects(request(Array(32).fill('00').join(':')), /certificate_changed/);
  assert.equal(received.length, 0, 'mismatched TLS peer must receive no HTTP request or credential');
  await request(fingerprint.toLowerCase());
  assert.equal(received.length, 1);
  assert.equal(received[0].authorization, 'Basic synthetic-test-only');
});

test('un-pinned discovery refuses headers, form bodies and mutations before opening a socket', () => {
  const phone = { ip_address: '127.0.0.1' };
  for (const options of [{headers:{Authorization:'synthetic'}}, {headers:{Cookie:'synthetic'}}, {body:'password=synthetic'}, {method:'POST'}]) {
    assert.throws(() => deviceWebRequest(phone, '/', options), /certificate_required/);
  }
  assert.throws(() => createDeviceTlsAgent({host:'127.0.0.1',fingerprint:'invalid'}), /invalid_certificate_pin/);
});

test('inventory text extraction cannot retain complete, nested or incomplete tags', () => {
  const table = value => `<td>Model Name</td><td>${value}</td>`;
  assert.equal(deviceTableText(table('&nbsp;<b>420HD</b>'), 'Model Name'), '420HD');
  for (const payload of ['420HD<script', '420HD<scr<script>ipt>', '420HD&lt;script', '420HD>']) {
    assert.doesNotMatch(deviceTableText(table(payload), 'Model Name'), /[<>]/);
  }
});

test('setup password change detection is keyed to the one-use token and rejects legacy hashes', async (t) => {
  const old = process.env.TELNYX_PHONE_ADMIN_PASSWORD;
  process.env.TELNYX_PHONE_ADMIN_PASSWORD = 'synthetic-managed-password';
  t.after(() => { if (old === undefined) delete process.env.TELNYX_PHONE_ADMIN_PASSWORD; else process.env.TELNYX_PHONE_ADMIN_PASSWORD = old; });
  const token = randomBytes(32).toString('hex');
  const password = process.env.TELNYX_PHONE_ADMIN_PASSWORD;
  const tag = setupPasswordTag(password, token);
  assert.notEqual(tag, createHash('sha256').update(password).digest('hex'));
  assert.notEqual(tag, setupPasswordTag(password, randomBytes(32).toString('hex')));
  const setup = { actor:'fixture-user',tokenHash:createHash('sha256').update(token).digest('hex'),passwordTag:tag,
    expires:new Date(Date.now()+60000).toISOString(),bridgeId:'fixture',ip:'192.0.2.1',host:'192.0.2.2' };
  let updates = 0;
  const db = {release(){},async query(sql){
    if(sql.startsWith('SELECT * FROM hp_phones')) return {rows:[{id:'fixture-phone',settings:{desktop_setup:setup}}]};
    if(sql.startsWith('UPDATE hp_phones')) updates++;
    return {rows:[],rowCount:0};
  }};
  const pool={connect:async()=>db},user={id:'fixture-user'},body={phoneId:'fixture-phone',setupToken:token,success:true};
  assert.deepEqual(await finishDesktopPhone(pool,user,body),{ok:true}); assert.equal(updates,1);
  process.env.TELNYX_PHONE_ADMIN_PASSWORD='changed-managed-password';
  await assert.rejects(finishDesktopPhone(pool,user,body),/managed password changed/); assert.equal(updates,1);
  process.env.TELNYX_PHONE_ADMIN_PASSWORD=password;
  delete setup.passwordTag; setup.passwordHash=createHash('sha256').update(password).digest('hex');
  await assert.rejects(finishDesktopPhone(pool,user,body),/managed password changed/);
});
