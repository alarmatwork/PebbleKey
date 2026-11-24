// Run with: node --test
// Exercises src/pkjs/volvo.js against a fake Volvo backend (no network).

var test = require('node:test');
var assert = require('node:assert');
var childProcess = require('node:child_process');
var path = require('node:path');
var createVolvo = require('../src/pkjs/volvo');

var ROOT = path.join(__dirname, '..');

// Setup code produced by the real login script, so both sides agree on the format.
function setupCode(refreshToken) {
  var py = [
    'import sys, json',
    'sys.path.insert(0, "tools")',
    'import volvo_login',
    'cfg = {"client_id": "cid", "client_secret": "s3cr+t/=", "api_key": "apikey", "vin": "YV1ABCDEFGH123456"}',
    'print(volvo_login.make_setup_code(cfg, sys.argv[1]))'
  ].join('\n');
  return childProcess.execFileSync('python3', ['-c', py, refreshToken], { cwd: ROOT }).toString().trim();
}

function makeStorage() {
  var data = {};
  return {
    getItem: function(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function(k, v) { data[k] = String(v); },
    data: data
  };
}

// Fake backend: `handler(request)` returns {status, body} or null for a network failure.
function makeXhr(handler, log) {
  return function FakeXhr() {
    var self = this;
    var req = { headers: {} };
    self.open = function(method, url) { req.method = method; req.url = url; };
    self.setRequestHeader = function(k, v) { req.headers[k] = v; };
    self.send = function(body) {
      req.body = body;
      log.push(req);
      setImmediate(function() {
        var res = handler(req);
        if (!res || res.blocked) {
          // The Pebble phone app flags a request it refused for lack of permission.
          self._notAllowed = !!res;
          self.onerror();
          return;
        }
        self.status = res.status;
        self.responseText = JSON.stringify(res.body);
        self.onload();
      });
    };
  };
}

function backend(opts) {
  opts = opts || {};
  var state = { refreshToken: 'rt-0', accessToken: null, n: 0 };
  return function(req) {
    if (req.url.indexOf('/openid-connect/token') !== -1) {
      if (opts.offline) {
        return null;
      }
      if (opts.blocked) {
        return { blocked: true };
      }
      var sent = decodeURIComponent(/refresh_token=([^&]+)$/.exec(req.body)[1]);
      if (sent !== state.refreshToken) {
        return { status: 400, body: { error: 'invalid_grant' } };
      }
      state.n += 1;
      state.refreshToken = 'rt-' + state.n;
      state.accessToken = 'at-' + state.n;
      return { status: 200, body: { access_token: state.accessToken, refresh_token: state.refreshToken, expires_in: 300 } };
    }
    if (opts.rejectFirstCommand && !state.rejected) {
      state.rejected = true;
      return { status: 401, body: {} };
    }
    if (req.headers.authorization !== 'Bearer ' + state.accessToken) {
      return { status: 401, body: {} };
    }
    if (req.method === 'GET') {
      var name = req.url.split('/').pop();
      var canned = (opts.status || {})[name];
      return canned ? { status: 200, body: { data: canned } } : { status: 403, body: {} };
    }
    return { status: 200, body: { data: { vin: 'YV1ABCDEFGH123456', invokeStatus: opts.invokeStatus || 'COMPLETED' } } };
  };
}

function setup(opts) {
  var log = [];
  var storage = makeStorage();
  var clock = { t: 1000000 };
  var volvo = createVolvo({
    XMLHttpRequest: makeXhr(backend(opts), log),
    storage: storage,
    now: function() { return clock.t; }
  });
  return { volvo: volvo, log: log, storage: storage, clock: clock };
}

function send(volvo, command) {
  return new Promise(function(resolve) {
    volvo.sendCommand(command, function(err, data) { resolve({ err: err, data: data }); });
  });
}

test('base64 round trip', function() {
  ['', 'a', 'ab', 'abc', 'cid:s3cr+t/=', '{"k":"v"}'].forEach(function(s) {
    assert.strictEqual(createVolvo.base64Encode(s), Buffer.from(s).toString('base64'));
    assert.strictEqual(createVolvo.base64Decode(Buffer.from(s).toString('base64url')), s);
  });
});

test('rejects bad setup codes and reports unconfigured', async function() {
  var s = setup();
  assert.strictEqual(s.volvo.isConfigured(), false);
  assert.strictEqual(s.volvo.importSetupCode('hello'), 'Not a setup code');
  assert.strictEqual(s.volvo.importSetupCode('EX30K1.!!!!'), 'Setup code is damaged');
  assert.strictEqual((await send(s.volvo, 'unlock')).err, 'Set up in Pebble app');
  assert.strictEqual(s.log.length, 0);
});

test('unlock: refreshes, stores the rotated token, sends the documented request', async function() {
  var s = setup();
  assert.strictEqual(s.volvo.importSetupCode('  ' + setupCode('rt-0') + '\n'), null);
  assert.strictEqual(s.volvo.describe(), 'Set up with your own keys, car VIN ending 123456.');

  var result = await send(s.volvo, 'unlock');
  assert.strictEqual(result.err, null);
  assert.strictEqual(s.log.length, 2);

  var tokenReq = s.log[0];
  assert.strictEqual(tokenReq.url, 'https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/token');
  assert.strictEqual(tokenReq.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.strictEqual(tokenReq.headers.authorization,
    'Basic ' + Buffer.from('cid:' + encodeURIComponent('s3cr+t/=')).toString('base64'));
  assert.strictEqual(tokenReq.body, 'grant_type=refresh_token&refresh_token=rt-0');

  var cmdReq = s.log[1];
  assert.strictEqual(cmdReq.method, 'POST');
  assert.strictEqual(cmdReq.url,
    'https://api.volvocars.com/connected-vehicle/v2/vehicles/YV1ABCDEFGH123456/commands/unlock');
  assert.strictEqual(cmdReq.headers['content-type'], 'application/json');
  assert.strictEqual(cmdReq.headers.authorization, 'Bearer at-1');
  assert.strictEqual(cmdReq.headers['vcc-api-key'], 'apikey');

  assert.strictEqual(JSON.parse(s.storage.data['ex30-tokens']).refreshToken, 'rt-1');
});

test('reuses a valid access token, refreshes again once it is about to expire', async function() {
  var s = setup();
  s.volvo.importSetupCode(setupCode('rt-0'));
  await send(s.volvo, 'lock');
  await send(s.volvo, 'unlock');
  assert.strictEqual(s.log.length, 3, 'one refresh, two commands');

  s.clock.t += 280 * 1000;  // inside the 30 s safety margin of a 300 s token
  assert.strictEqual((await send(s.volvo, 'lock')).err, null);
  assert.strictEqual(s.log.length, 5, 'second refresh used the rotated token');
  assert.strictEqual(JSON.parse(s.storage.data['ex30-tokens']).refreshToken, 'rt-2');
});

test('concurrent requests share one refresh', async function() {
  var s = setup();
  s.volvo.importSetupCode(setupCode('rt-0'));
  var warm = new Promise(function(resolve) { s.volvo.getAccessToken(resolve); });
  var result = await send(s.volvo, 'unlock');
  await warm;
  assert.strictEqual(result.err, null);
  var refreshes = s.log.filter(function(r) { return r.url.indexOf('/token') !== -1; });
  assert.strictEqual(refreshes.length, 1);
});

test('a 401 on the command triggers one fresh token and one retry', async function() {
  var s = setup({ rejectFirstCommand: true });
  s.volvo.importSetupCode(setupCode('rt-0'));
  assert.strictEqual((await send(s.volvo, 'lock')).err, null);
  assert.strictEqual(s.log.length, 4);
});

test('maps failures to short messages', async function() {
  var asleep = setup({ invokeStatus: 'VEHICLE_IN_SLEEP' });
  asleep.volvo.importSetupCode(setupCode('rt-0'));
  assert.strictEqual((await send(asleep.volvo, 'unlock')).err, 'Car is asleep');

  var expired = setup();
  expired.volvo.importSetupCode(setupCode('rt-old'));
  assert.strictEqual((await send(expired.volvo, 'unlock')).err, 'Login expired, redo setup');

  var offline = setup({ offline: true });
  offline.volvo.importSetupCode(setupCode('rt-0'));
  assert.strictEqual((await send(offline.volvo, 'unlock')).err, 'No internet on phone');

  var blocked = setup({ blocked: true });
  blocked.volvo.importSetupCode(setupCode('rt-0'));
  assert.strictEqual((await send(blocked.volvo, 'unlock')).err, 'Allow internet in Pebble app');
});

test('climate toggle: starts, stops, and starts again once a run has timed out', async function() {
  var s = setup();
  s.volvo.importSetupCode(setupCode('rt-0'));
  function toggle() {
    return new Promise(function(resolve) {
      s.volvo.toggleClimate(function(err, isOn) { resolve({ err: err, isOn: isOn }); });
    });
  }
  function lastCommand() {
    return s.log[s.log.length - 1].url.split('/commands/')[1];
  }

  assert.strictEqual(s.volvo.climateIsOn(), false);
  assert.deepStrictEqual(await toggle(), { err: null, isOn: true });
  assert.strictEqual(lastCommand(), 'climatization-start');
  assert.strictEqual(s.volvo.climateIsOn(), true);

  assert.deepStrictEqual(await toggle(), { err: null, isOn: false });
  assert.strictEqual(lastCommand(), 'climatization-stop');

  assert.deepStrictEqual(await toggle(), { err: null, isOn: true });
  s.clock.t += 31 * 60 * 1000;  // the car has ended the run by itself
  assert.strictEqual(s.volvo.climateIsOn(), false);
  assert.deepStrictEqual(await toggle(), { err: null, isOn: true });
  assert.strictEqual(lastCommand(), 'climatization-start');
});

test('climate toggle: a failed command leaves the remembered state alone', async function() {
  var s = setup({ invokeStatus: 'CAR_ERROR' });
  s.volvo.importSetupCode(setupCode('rt-0'));
  var err = await new Promise(function(resolve) { s.volvo.toggleClimate(resolve); });
  assert.strictEqual(err, 'Car reported an error');
  assert.strictEqual(s.volvo.climateIsOn(), false);
});

test('climate commands accept RUNNING as success', async function() {
  var s = setup({ invokeStatus: 'RUNNING' });
  s.volvo.importSetupCode(setupCode('rt-0'));
  var isOn = await new Promise(function(resolve) {
    s.volvo.toggleClimate(function(err, on) { resolve(err || on); });
  });
  assert.strictEqual(isOn, true);
});

function status(volvo) {
  return new Promise(function(resolve) {
    volvo.getStatus(function(err, st) { resolve({ err: err, status: st }); });
  });
}

test('status: reads lock state, open doors and battery', async function() {
  var s = setup({ status: {
    doors: {
      centralLock: { value: 'UNLOCKED' },
      frontLeftDoor: { value: 'CLOSED' },
      rearRightDoor: { value: 'CLOSED' },
      tailgate: { value: 'AJAR' },
      hood: { value: 'CLOSED' }
    },
    fuel: { batteryChargeLevel: { value: 77.6, unit: '%' } }
  } });
  s.volvo.importSetupCode(setupCode('rt-0'));
  var result = await status(s.volvo);
  assert.strictEqual(result.err, null);
  assert.deepStrictEqual(result.status, { locked: false, open: ['boot'], battery: 78 });
  var doors = s.log.filter(function(r) { return /\/doors$/.test(r.url); })[0];
  assert.strictEqual(doors.method, 'GET');
  assert.strictEqual(doors.body, null);
  assert.strictEqual(doors.headers['vcc-api-key'], 'apikey');
  assert.strictEqual(s.log.filter(function(r) { return r.url.indexOf('/token') !== -1; }).length, 1);
});

test('status: a part without its scope is left out, all parts failing is an error', async function() {
  var partial = setup({ status: { doors: { centralLock: { value: 'LOCKED' } } } });
  partial.volvo.importSetupCode(setupCode('rt-0'));
  var result = await status(partial.volvo);
  assert.strictEqual(result.err, null);
  assert.deepStrictEqual(result.status, { locked: true, open: [], battery: null });

  var none = setup();
  none.volvo.importSetupCode(setupCode('rt-0'));
  assert.strictEqual((await status(none.volvo)).err, 'Not allowed (scopes?)');
});

test('car state as the watch draws it', function() {
  var f = createVolvo.watchStatus;
  assert.deepStrictEqual(f({ locked: true, open: [], battery: 78 }), { lock: 1, battery: 78, open: '' });
  assert.deepStrictEqual(f({ locked: false, open: ['boot'], battery: 78 }), { lock: 2, battery: 78, open: 'Boot open' });
  assert.deepStrictEqual(f({ locked: false, open: ['door', 'boot'], battery: null }), { lock: 2, battery: -1, open: 'Car open' });
  assert.deepStrictEqual(f({ locked: null, open: null, battery: 5 }), { lock: 0, battery: 5, open: '' });
  assert.deepStrictEqual(f({ locked: null, open: null, battery: 104 }), { lock: 0, battery: 100, open: '' });
});

test('car location: reads the GeoJSON point from the Location API', async function() {
  var s = setup({ status: { location: { type: 'Feature', geometry: { type: 'Point', coordinates: [11.968, 57.688, 0] } } } });
  s.volvo.importSetupCode(setupCode('rt-0'));
  var result = await new Promise(function(resolve) {
    s.volvo.getCarLocation(function(err, point) { resolve(err || point); });
  });
  assert.deepStrictEqual(result, { lat: 57.688, lon: 11.968 });
  assert.strictEqual(s.log[s.log.length - 1].url,
    'https://api.volvocars.com/location/v1/vehicles/YV1ABCDEFGH123456/location');

  var denied = setup();
  denied.volvo.importSetupCode(setupCode('rt-0'));
  var err = await new Promise(function(resolve) { denied.volvo.getCarLocation(resolve); });
  assert.strictEqual(err, 'Not allowed (scopes?)');
});

// --- Signing in through a sign-in service (broker/) instead of own Volvo keys ---

var BROKER = 'https://pebblekey.example.workers.dev';

function brokerCode(fields) {
  return 'EX30K2.' + Buffer.from(JSON.stringify(fields)).toString('base64url');
}

// Fake sign-in service plus fake Volvo API. `refresh(req)` answers POST /refresh.
function brokerSetup(refresh, brokerUrl) {
  var log = [];
  var storage = makeStorage();
  var volvo = createVolvo({
    XMLHttpRequest: makeXhr(function(req) {
      if (req.url === BROKER + '/refresh') {
        return refresh(req);
      }
      return { status: 200, body: { data: { invokeStatus: 'COMPLETED' } } };
    }, log),
    storage: storage,
    now: function() { return 1000000; },
    brokerUrl: brokerUrl === undefined ? BROKER + '/' : brokerUrl
  });
  return { volvo: volvo, log: log, storage: storage };
}

test('broker setup code: refreshes through the service, without any client secret', async function() {
  var s = brokerSetup(function() {
    return { status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 300, api_key: 'key-1' } };
  });
  assert.strictEqual(
    s.volvo.importSetupCode(brokerCode({ k: 'key-1', v: 'yv1abcdefgh123456', r: 'rt-0' })), null);
  assert.strictEqual(s.volvo.describe(), 'Signed in with Volvo, car VIN ending 123456.');
  assert.strictEqual((await send(s.volvo, 'lock')).err, null);

  var refresh = s.log[0];
  assert.strictEqual(refresh.method, 'POST');
  assert.strictEqual(refresh.url, BROKER + '/refresh');
  assert.strictEqual(refresh.body, 'refresh_token=rt-0');
  assert.strictEqual(refresh.headers.authorization, undefined);

  var command = s.log[1];
  assert.match(command.url, /\/vehicles\/YV1ABCDEFGH123456\/commands\/lock$/);
  assert.strictEqual(command.headers.authorization, 'Bearer at-1');
  assert.strictEqual(command.headers['vcc-api-key'], 'key-1');
  assert.strictEqual(JSON.parse(s.storage.data['ex30-tokens']).refreshToken, 'rt-1');
  assert.ok(!('clientSecret' in JSON.parse(s.storage.data['ex30-creds'])));
});

test('broker: a replaced API key is picked up from the next refresh', async function() {
  var s = brokerSetup(function() {
    return { status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 300, api_key: 'key-2' } };
  });
  s.volvo.importSetupCode(brokerCode({ k: 'key-1', v: 'YV1ABCDEFGH123456', r: 'rt-0' }));
  await send(s.volvo, 'lock');
  assert.strictEqual(s.log[1].headers['vcc-api-key'], 'key-2');
  assert.strictEqual(JSON.parse(s.storage.data['ex30-creds']).apiKey, 'key-2');
});

test('broker: expired login and a failing service give different messages', async function() {
  var code = brokerCode({ k: 'key-1', v: 'YV1ABCDEFGH123456', r: 'rt-0' });
  var cases = [
    [{ status: 400, body: { error: 'invalid_grant' } }, 'Login expired, sign in again'],
    [{ status: 502, body: { error: 'upstream' } }, 'Sign-in service error 502'],
    [{ status: 500, body: { error: 'not_configured' } }, 'Sign-in service error 500'],
    [null, 'No internet on phone'],
    [{ blocked: true }, 'Allow internet in Pebble app']
  ];
  for (var i = 0; i < cases.length; i++) {
    var answer = cases[i][0];
    var s = brokerSetup(function() { return answer; });
    s.volvo.importSetupCode(code);
    assert.strictEqual((await send(s.volvo, 'lock')).err, cases[i][1]);
    // A failed refresh must not lose the refresh token.
    assert.strictEqual(JSON.parse(s.storage.data['ex30-tokens']).refreshToken, 'rt-0');
  }
});

test('broker setup code needs a build with a sign-in service, and all its fields', function() {
  var code = brokerCode({ k: 'key-1', v: 'YV1ABCDEFGH123456', r: 'rt-0' });
  var without = brokerSetup(function() { return null; }, '');
  assert.strictEqual(without.volvo.importSetupCode(code), 'This build has no sign-in');
  assert.strictEqual(without.volvo.isConfigured(), false);

  var s = brokerSetup(function() { return null; });
  assert.strictEqual(s.volvo.importSetupCode(brokerCode({ k: 'key-1', v: 'YV1ABCDEFGH123456' })),
    'Setup code incomplete');
  // An own-keys code is still incomplete without its client secret.
  assert.strictEqual(
    s.volvo.importSetupCode('EX30K1.' + Buffer.from(JSON.stringify({ k: 'k', v: 'v', r: 'r' })).toString('base64url')),
    'Setup code incomplete');
});

test('own-keys setup code still refreshes directly with Volvo in a sign-in build', async function() {
  var log = [];
  var volvo = createVolvo({
    XMLHttpRequest: makeXhr(backend(), log),
    storage: makeStorage(),
    brokerUrl: BROKER
  });
  assert.strictEqual(volvo.importSetupCode(setupCode('rt-0')), null);
  assert.strictEqual(volvo.describe(), 'Set up with your own keys, car VIN ending 123456.');
  assert.strictEqual((await send(volvo, 'lock')).err, null);
  assert.match(log[0].url, /auth\.volvocars\.com.*\/token$/);
  assert.match(log[0].headers.authorization, /^Basic /);
  assert.match(log[0].body, /^grant_type=refresh_token&refresh_token=rt-0$/);
});
