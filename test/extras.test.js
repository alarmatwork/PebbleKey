// Run with: node --test
// The DOWN menu (src/pkjs/extras.js) against fake car data.
var test = require('node:test');
var assert = require('node:assert');
var createExtras = require('../src/pkjs/extras');
var createLockState = require('../src/pkjs/lockstate');

function setup(opts) {
  var sent = [];
  var reads = [];
  var volvo = {
    mayUse: function(scope) { return !opts.scopes || opts.scopes.indexOf(scope) !== -1; },
    getLock: function(cb) { reads.push('doors'); cb(null, opts.lock || { locked: true, lockedAt: null, open: [] }); },
    getStatus: function(cb) {
      cb(null, { battery: 64, range: { value: 230, unit: 'km' }, charge: null });
    },
    read: function(service, path, cb) {
      reads.push(path);
      var data = (opts.data || {})[path];
      if (data) {
        cb(null, data);
      } else {
        cb('Not allowed (scopes?)');
      }
    },
    sendCommand: function(name, cb) { sent.push(name); cb(opts.commandError || null, {}); }
  };
  var proximity = {
    locate: function(cb) { cb(null, { meters: 1234, accuracy: 10, direction: 'NE' }); }
  };
  var extras = createExtras({ volvo: volvo, proximity: proximity, lockState: createLockState() });
  return { extras: extras, sent: sent, reads: reads };
}

function run(extras, id) {
  return new Promise(function(resolve) {
    var progress = null;
    extras.run(id, function(text) { progress = text; }, function(err, text, details) {
      resolve({ err: err, text: text, details: details, progress: progress });
    });
  });
}

test('the menu lists only what the login may do', function() {
  assert.strictEqual(setup({}).extras.menu(),
    'info:Car info\nfind:Find car\nflash:Flash lights\nhonk:Honk & flash');
  assert.strictEqual(setup({ scopes: ['openid', 'conve:lock'] }).extras.menu(), 'info:Car info');
  assert.strictEqual(setup({ scopes: ['conve:honk_flash'] }).extras.menu(),
    'info:Car info\nflash:Flash lights\nhonk:Honk & flash');
});

test('flash and honk send their commands', async function() {
  var s = setup({});
  assert.deepStrictEqual(await run(s.extras, 'flash'),
    { err: null, text: 'Lights flashed', details: undefined, progress: 'Flashing...' });
  await run(s.extras, 'honk');
  assert.deepStrictEqual(s.sent, ['flash', 'honk-flash']);
  assert.strictEqual((await run(setup({ commandError: 'Car is asleep' }).extras, 'flash')).err, 'Car is asleep');
});

test('an item the login may not use is refused without asking the car', async function() {
  var s = setup({ scopes: ['conve:lock'] });
  assert.strictEqual((await run(s.extras, 'honk')).err, 'Not available');
  assert.deepStrictEqual(s.sent, []);
});

test('find car says how far and which way', async function() {
  assert.strictEqual((await run(setup({}).extras, 'find')).text, 'Car is 1.2 km NE');
});

test('car info puts together what can be read, and skips what the login may not read', async function() {
  var s = setup({
    scopes: ['conve:lock_status', 'energy:state:read', 'conve:windows_status', 'conve:tyre_status',
      'conve:odometer_status'],
    lock: { locked: false, lockedAt: null, open: ['boot'] },
    data: {
      windows: { frontLeftWindow: { value: 'OPEN' }, rearRightWindow: { value: 'CLOSED' }, sunroof: { value: 'UNSPECIFIED' } },
      tyres: { frontLeft: { value: 'NO_WARNING' }, rearRight: { value: 'LOW_PRESSURE' } },
      odometer: { odometer: { value: 12345, unit: 'kilometers' } }
    }
  });
  var result = await run(s.extras, 'info');
  assert.strictEqual(result.err, null);
  assert.strictEqual(result.text, 'Car info');
  assert.strictEqual(result.details, [
    'Unlocked, boot open',
    'Battery 64%, 230 km',
    '1 window open',
    'Check tyres: RR',
    'Odometer 12 345 km'
  ].join('\n'));
  // No location scope: the car's position is not asked for.
  assert.ok(s.reads.indexOf('location') === -1);
});

test('car info leaves out parts that fail', async function() {
  var s = setup({ scopes: ['conve:lock_status', 'conve:odometer_status'] });
  assert.strictEqual((await run(s.extras, 'info')).details, 'Locked, all shut');
});
