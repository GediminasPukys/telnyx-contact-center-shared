import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import redirects from 'follow-redirects';

test('cross-origin redirects strip standard and custom credential headers in both supported header forms', async (t) => {
  const received = [];
  const destination = http.createServer((request, response) => {
    received.push(request.headers);
    response.end('ok');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const source = http.createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/target` });
    response.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(() => Promise.all([source, destination].map(server => new Promise(resolve => server.close(resolve)))));

  const entries = [
    ['Authorization', 'Bearer synthetic-redirect-test'],
    ['Cookie', 'synthetic=value'],
    ['Proxy-Authorization', 'Basic synthetic'],
    ['X-Api^Key', 'synthetic-key'],
    ['X-Token|Secret', 'synthetic-token'],
    ['X-Public', 'preserved'],
  ];
  for (const headers of [Object.fromEntries(entries), entries.flat()]) {
    await new Promise((resolve, reject) => {
      // Changing hostname and port creates a different origin without external traffic.
      const request = redirects.http.get({
        hostname: 'localhost', port: source.address().port, path: '/',
        lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
        headers, sensitiveHeaders: ['X-Api^Key', 'X-Token|Secret'], timeout: 3000,
      }, response => { response.resume(); response.on('end', resolve); });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('local redirect test timed out')));
    });
  }
  assert.equal(received.length, 2);
  for (const headers of received) {
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api^key', 'x-token|secret']) {
      assert.equal(headers[name], undefined, `${name} must not cross origins`);
    }
    assert.equal(headers['x-public'], 'preserved');
  }
});
