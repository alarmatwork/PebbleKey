// Run with: node --test
var test = require('node:test');
var assert = require('node:assert');
var createProximity = require('../src/pkjs/proximity');

// Roughly Gothenburg; 0.001 degrees of latitude is about 111 m.
var CAR = { lat: 57.7000, lon: 11.9700 };

function setup(opts) {
  var calls = { car: 0, phone: 0 };
  var clock = { t: 5000000 };
  var proximity = createProximity({
    volvo: {
      getCarLocation: function(cb) {
        calls.car += 1;
        setImmediate(function() { opts.carError ? cb(opts.carError) : cb(null, CAR); });
      }
    },
    geolocation: opts.noGeolocation ? null : {
      getCurrentPosition: function(ok, fail) {
        calls.phone += 1;
        if (opts.silent) {
          return;
        }
        setImmediate(function() {
          if (opts.phoneError) {
            fail(opts.phoneError);
          } else {
            ok({ coords: { latitude: opts.phone.lat, longitude: opts.phone.lon, accuracy: opts.phone.accuracy } });
          }
        });
      }
    },
    now: function() { return clock.t; },
    // Fire the watchdog straight away for the silent case, never otherwise.
    setTimeout: function(fn) { if (opts.silent) { setImmediate(fn); } }
  });
  return { proximity: proximity, calls: calls, clock: clock };
}

function check(proximity, limit) {
  return new Promise(function(resolve) { proximity.check(limit, resolve); });
}

test('distance and its wording', function() {
  var d = createProximity.distanceMeters(57.7, 11.97, 57.701, 11.97);
  assert.ok(d > 110 && d < 112, 'got ' + d);
  assert.strictEqual(createProximity.formatDistance(347), '350 m');
  assert.strictEqual(createProximity.formatDistance(2340), '2.3 km');
  assert.strictEqual(createProximity.formatDistance(48200), '48 km');
});

test('phone next to the car is near', async function() {
  var s = setup({ phone: { lat: 57.7003, lon: 11.9700, accuracy: 10 } });
  var result = await check(s.proximity, 200);
  assert.strictEqual(result.near, true);
});

test('phone far from the car is not near and says how far', async function() {
  var s = setup({ phone: { lat: 57.7210, lon: 11.9700, accuracy: 10 } });
  var result = await check(s.proximity, 200);
  assert.strictEqual(result.near, false);
  assert.strictEqual(result.text, 'Car is 2.3 km away');
});

test('a rough phone fix gets slack, but only up to the limit', async function() {
  // About 330 m away: outside 200 m, inside 200 m + 200 m of slack.
  var rough = setup({ phone: { lat: 57.7030, lon: 11.9700, accuracy: 5000 } });
  assert.strictEqual((await check(rough.proximity, 200)).near, true);
  var sharp = setup({ phone: { lat: 57.7030, lon: 11.9700, accuracy: 10 } });
  assert.strictEqual((await check(sharp.proximity, 200)).near, false);
  // About 2.3 km away stays far even with a useless fix.
  var far = setup({ phone: { lat: 57.7210, lon: 11.9700, accuracy: 5000 } });
  assert.strictEqual((await check(far.proximity, 200)).near, false);
});

test('an unknown position is never treated as near', async function() {
  var noCar = setup({ carError: 'Not allowed (scopes?)', phone: { lat: 57.7, lon: 11.97, accuracy: 5 } });
  assert.deepStrictEqual(await check(noCar.proximity, 200), { near: false, text: 'No car location' });

  var denied = setup({ phoneError: { code: 1, message: 'denied' } });
  assert.strictEqual((await check(denied.proximity, 200)).text, 'Allow location in Pebble app');

  var noFix = setup({ phoneError: { code: 3, message: 'timeout' } });
  assert.strictEqual((await check(noFix.proximity, 200)).text, 'No phone location');

  var noApi = setup({ noGeolocation: true });
  assert.strictEqual((await check(noApi.proximity, 200)).text, 'No phone location');

  var silent = setup({ silent: true });
  assert.strictEqual((await check(silent.proximity, 200)).text, 'No phone location');
});

test('the car position is fetched once and reused for a minute', async function() {
  var s = setup({ phone: { lat: 57.7003, lon: 11.9700, accuracy: 10 } });
  s.proximity.prefetch();
  await new Promise(setImmediate);
  await check(s.proximity, 200);
  assert.strictEqual(s.calls.car, 1);
  s.clock.t += 61000;
  await check(s.proximity, 200);
  assert.strictEqual(s.calls.car, 2);
});
