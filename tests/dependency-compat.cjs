const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const test = require('node:test');

// No external requests or blockchain transactions. The HTTP check uses loopback.
// Exercise the installed graph: incompatible npm overrides must fail these checks.
test('OpenTimestamps can load with its HTTP dependencies', () => {
  const ots = require('opentimestamps');
  assert.equal(typeof ots.DetachedTimestampFile.fromHash, 'function');
  assert.equal(typeof ots.verify, 'function');
});

test('calendar whitelist accepts known hosts and rejects lookalikes', () => {
  const { DEFAULT_CALENDAR_WHITELIST: whitelist, UrlWhitelist } = require('opentimestamps/src/calendar.js');
  assert.equal(whitelist.contains('https://alice.btc.calendar.opentimestamps.org'), true);
  assert.equal(whitelist.contains('https://alice.btc.calendar.opentimestamps.org.attacker.example'), false);
  assert.equal(whitelist.contains('https://attacker.example'), false);
  assert.equal(whitelist.contains('http://alice.btc.calendar.opentimestamps.org'), false);
  const selected = new UrlWhitelist(['https://{alice,bob}.btc.calendar.opentimestamps.org']);
  assert.equal(selected.contains('https://alice.btc.calendar.opentimestamps.org'), true);
  assert.equal(selected.contains('https://bob.btc.calendar.opentimestamps.org'), true);
  assert.equal(selected.contains('https://eve.btc.calendar.opentimestamps.org'), false);
});

test('pending proof round-trips without losing its digest or calendar', () => {
  const ots = require('opentimestamps');
  const { PendingAttestation } = require('opentimestamps/src/notary.js');
  const digest = createHash('sha256').update('PURAMA offline compatibility fixture').digest();
  const calendar = 'https://alice.btc.calendar.opentimestamps.org';
  const original = ots.DetachedTimestampFile.fromHash(new ots.Ops.OpSHA256(), Array.from(digest));
  original.timestamp.attestations.push(new PendingAttestation(calendar));
  const bytes = original.serializeToBytes();
  const restored = ots.DetachedTimestampFile.deserialize(bytes);
  assert.deepEqual(Buffer.from(restored.fileDigest()), digest);
  assert.equal(restored.timestamp.attestations.length, 1);
  assert.equal(restored.timestamp.attestations[0].uri, calendar);
  assert.deepEqual(Buffer.from(restored.serializeToBytes()), Buffer.from(bytes));
  assert.throws(() => ots.DetachedTimestampFile.deserialize(bytes.slice(0, 10)));
});

test('Bitcore retains exact integer arithmetic and byte conversion', () => {
  const BN = require('bitcore-lib/lib/crypto/bn.js');
  const value = BigInt('0x123456789abcdef123456789abcdef');
  const divisor = 97n;
  const actual = BN.fromString(value.toString(16), 16);
  assert.equal(actual.mul(new BN(97)).toString(10), (value * divisor).toString());
  assert.equal(actual.div(new BN(97)).toString(10), (value / divisor).toString());
  assert.equal(actual.mod(new BN(97)).toString(10), (value % divisor).toString());
  assert.equal(BN.fromBuffer(actual.toBuffer()).toString(16), value.toString(16));
});

test('HTTP fork preserves promise, binary body, cookies and rejection contracts', { timeout: 5000 }, async (t) => {
  const request = require('request-promise');
  const server = createServer((req, res) => {
    if (req.url === '/reject') {
      res.writeHead(403).end('denied');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Set-Cookie', 'purama_compat=ok; Path=/');
      res.end(Buffer.concat(chunks));
    });
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const uri = `http://127.0.0.1:${server.address().port}`;
  const jar = request.jar();
  const body = Buffer.from([0, 128, 255, 1]);
  // Match RemoteCalendar.submit's URL object and binary request shape.
  const response = await request({ url: new URL(uri), method: 'POST', body, encoding: null, jar, proxy: null, timeout: 2000 });
  assert.deepEqual(response, body);
  assert.equal(jar.getCookieString(uri), 'purama_compat=ok');
  await assert.rejects(request.get({ uri: `${uri}/reject`, proxy: null, timeout: 2000 }), { statusCode: 403 });
});
