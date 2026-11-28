// Run with: node --test
var test = require('node:test');
var assert = require('node:assert');
var createLockState = require('../src/pkjs/lockstate');

function setup() {
  var clock = { t: 1000000 };
  return { clock: clock, lock: createLockState({ now: function() { return clock.t; } }) };
}

test('without a command, the car report is shown as it is', function() {
  var s = setup();
  assert.deepStrictEqual(s.lock.effective(false, 5), { locked: false, settled: true });
  assert.deepStrictEqual(s.lock.effective(null, null), { locked: null, settled: true });
  assert.strictEqual(s.lock.lastCommand(), null);
});

test('a report from before the lock does not undo it on the watch', function() {
  var s = setup();
  s.lock.commandDone(true, s.clock.t);
  s.clock.t += 8000;
  // The car still says what it said before the command.
  assert.deepStrictEqual(s.lock.effective(false, s.clock.t - 60000), { locked: true, settled: false });
  assert.deepStrictEqual(s.lock.effective(null, null), { locked: true, settled: false });
  // Now it has reported the lock.
  assert.deepStrictEqual(s.lock.effective(true, s.clock.t), { locked: true, settled: true });
  assert.deepStrictEqual(s.lock.effective(false, s.clock.t - 60000), { locked: false, settled: true });
  assert.strictEqual(s.lock.lastCommand(), true);
});

test('a newer report wins even when it disagrees, e.g. the car was unlocked with the key', function() {
  var s = setup();
  s.lock.commandDone(true, s.clock.t);
  s.clock.t += 20000;
  assert.deepStrictEqual(s.lock.effective(false, s.clock.t - 5000), { locked: false, settled: true });
});

test('reports without a time count once they agree, and the command is forgotten after a while', function() {
  var s = setup();
  s.lock.commandDone(false, s.clock.t);
  assert.deepStrictEqual(s.lock.effective(true, null), { locked: false, settled: false });
  assert.deepStrictEqual(s.lock.effective(false, null), { locked: false, settled: true });

  s.lock.commandDone(true, s.clock.t);
  s.clock.t += 4 * 60 * 1000;
  assert.deepStrictEqual(s.lock.effective(false, null), { locked: false, settled: true });
});
