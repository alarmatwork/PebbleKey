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
  assert.strictEqual(s.volvo.describe(), 'Set up for VIN ending 123456.');

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

test('status line formatting', function() {
  var f = createVolvo.formatStatus;
  assert.strictEqual(f({ locked: true, open: [], battery: 78 }), 'Locked, 78%');
  assert.strictEqual(f({ locked: false, open: ['boot'], battery: 78 }), 'Unlocked, boot open');
  assert.strictEqual(f({ locked: false, open: ['door', 'boot'], battery: null }), 'Unlocked, car open');
  assert.strictEqual(f({ locked: null, open: null, battery: 5 }), '5%');
  assert.strictEqual(f({ locked: true, open: null, battery: null }), 'Locked');
  assert.strictEqual(f({ locked: null, open: null, battery: null }), '');
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
