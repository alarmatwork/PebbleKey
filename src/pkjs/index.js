var Clay = require('@rebble/clay');
var clayConfig = require('./config.json');
var customClay = require('./custom-clay');
var brokerConfig = require('./broker.json');
var createVolvo = require('./volvo');
var createProximity = require('./proximity');
var createLockState = require('./lockstate');
var createExtras = require('./extras');

// Keep in sync with src/c/main.c.
var CMD_UNLOCK = 1;
var CMD_LOCK = 2;
var CMD_CLIMATE = 4;
var CMD_UNLOCK_ANYWAY = 5;
var CMD_TOGGLE = 6;
var CMD_EXTRA = 7;
// After a lock or unlock, read the car's state back this long after it, until the car has
// reported its new state.
var FOLLOW_UP_MS = [5000, 15000, 30000, 60000, 120000];
// When Volvo could not say whether a lock or unlock went through, look at the car this often.
var VERIFY_MS = [3000, 6000, 10000, 15000];
// After this long without an answer the watch says the car is being slow, not stuck.
var SLOW_NOTE_MS = 15000;
var STATUS_PROGRESS = 0;
var STATUS_OK = 1;
var STATUS_ERROR = 2;
var STATUS_CONFIRM = 3;
var STATUS_NOTICE = 4;
var DEFAULT_UNLOCK_RANGE_M = 200;

// The sign-in service this build uses (see broker/), or '' for a build without one.
var BROKER_URL = String(brokerConfig.url || '').replace(/\/+$/, '');

// Settings stay on the phone, so Clay must not push them to the watch.
var clay = new Clay(clayConfig, customClay, {
  autoHandleEvents: false,
  userData: { signInUrl: BROKER_URL }
});
var volvo = createVolvo({
  XMLHttpRequest: XMLHttpRequest,
  storage: localStorage,
  brokerUrl: BROKER_URL
});
var proximity = createProximity({
  volvo: volvo,
  geolocation: typeof navigator !== 'undefined' ? navigator.geolocation : null
});
var lockState = createLockState();
var extras = createExtras({ volvo: volvo, proximity: proximity, lockState: lockState });

// Lock states as the watch draws them (see watchStatus in volvo.js).
var LOCK_LOCKED = 1;
var LOCK_UNLOCKED = 2;

// `extra` carries car state that the result itself makes known, e.g. { LockState: LOCK_LOCKED }.
function tellWatch(status, message, extra) {
  var payload = { Status: status, Message: String(message).slice(0, 40) };
  Object.keys(extra || {}).forEach(function(key) {
    payload[key] = extra[key];
  });
  Pebble.sendAppMessage(payload,
    function() {},
    function() { console.log('Could not reach the watch: ' + message); });
}

function lockValue(locked) {
  return locked === true ? LOCK_LOCKED : locked === false ? LOCK_UNLOCKED : 0;
}

// Ask Volvo what the car last reported and show it on the watch. `cb(settled)`, if given,
// learns whether the car has reported its lock state since the last lock or unlock.
function refreshStatus(cb) {
  cb = cb || function() {};
  if (!volvo.isConfigured()) {
    cb(true);
    return;
  }
  volvo.getStatus(function(err, status) {
    if (err) {
      console.log('Status failed: ' + err);
      if (createVolvo.isLoginExpired(err)) {
        // Say so right away, rather than only once the user holds a button.
        tellWatch(STATUS_NOTICE, err);
      }
      cb(false);
      return;
    }
    var lock = lockState.effective(status.locked, status.lockedAt);
    status.locked = lock.locked;
    var state = createVolvo.watchStatus(status);
    Pebble.sendAppMessage({
      LockState: state.lock,
      Battery: state.battery,
      Info: state.open,
      Climate: volvo.climateIsOn() ? 1 : 0,
      Charging: state.charging,
      ChargeInfo: state.charge,
      // The login's scopes become known with its first refresh.
      Menu: extras.menu()
    });
    cb(lock.settled);
  });
}

// Keep reading the car's state back until it has reported the result of the last command.
var followUpTimer = null;
function followUp() {
  clearTimeout(followUpTimer);
  var step = 0;
  var started = Date.now();
  function next() {
    if (step >= FOLLOW_UP_MS.length) {
      return;
    }
    followUpTimer = setTimeout(function() {
      step += 1;
      refreshStatus(function(settled) {
        if (!settled) {
          next();
        }
      });
    }, FOLLOW_UP_MS[step] - (Date.now() - started));
  }
  next();
}

// Tell the watch after a while that the car is still being waited for. Returns the cancel.
function slowNote(text) {
  var timer = setTimeout(function() { tellWatch(STATUS_PROGRESS, text); }, SLOW_NOTE_MS);
  return function() { clearTimeout(timer); };
}

// How far from the car (in metres) an unlock goes through without asking; 0 switches the
// distance check off.
function unlockRange() {
  var settings = {};
  try {
    settings = JSON.parse(localStorage.getItem('clay-settings')) || {};
  } catch (e) {
    // Fall through to the default.
  }
  var range = Number(settings.UnlockRange);
  return settings.UnlockRange === undefined || isNaN(range) ? DEFAULT_UNLOCK_RANGE_M : range;
}

// Unlock only if the phone is near the car; otherwise the watch asks for a second hold,
// which arrives here with `anyway` set.
function runUnlock(anyway) {
  var range = unlockRange();
  if (anyway || !range || !volvo.isConfigured()) {
    run('unlock');
    return;
  }
  tellWatch(STATUS_PROGRESS, 'Checking distance...');
  proximity.check(range, function(result) {
    if (result.near) {
      run('unlock');
    } else {
      console.log('Unlock held back: ' + result.text);
      tellWatch(STATUS_CONFIRM, result.text);
    }
  });
}

function runClimate() {
  tellWatch(STATUS_PROGRESS, volvo.climateIsOn() ? 'Stopping climate...' : 'Starting climate...');
  var stopNote = slowNote('Waiting for the car...');
  volvo.toggleClimate(function(err, isOn, unconfirmed) {
    stopNote();
    if (err) {
      console.log('climate failed: ' + err);
      tellWatch(STATUS_ERROR, err);
      return;
    }
    // Volvo gave up waiting for the car's answer, but the car nearly always does it anyway.
    var text = (isOn ? 'Climate on' : 'Climate off') + (unconfirmed ? ', car slow to confirm' : '');
    tellWatch(STATUS_OK, text, { Climate: isOn ? 1 : 0 });
  });
}

function lockDone(locked, sentAt) {
  lockState.commandDone(locked, sentAt);
  tellWatch(STATUS_OK, locked ? 'Locked' : 'Unlocked', { LockState: lockValue(locked) });
  followUp();
}

// Volvo could not say whether the command went through: look at the car to find out.
function verifyLock(locked, sentAt, err) {
  tellWatch(STATUS_PROGRESS, 'Checking the car...');
  var step = 0;
  function check() {
    setTimeout(function() {
      volvo.getLock(function(readErr, lock) {
        // Only a report made since the command tells anything.
        var isNew = !readErr && (lock.lockedAt === null || lock.lockedAt >= sentAt);
        if (isNew && lock.locked === locked) {
          lockDone(locked, sentAt);
        } else if (++step < VERIFY_MS.length) {
          check();
        } else {
          tellWatch(STATUS_ERROR, err);
          refreshStatus();
        }
      });
    }, VERIFY_MS[step]);
  }
  check();
}

function run(command) {
  if (command === 'climate') {
    runClimate();
    return;
  }
  var locked = command === 'lock';
  var sentAt = Date.now();
  tellWatch(STATUS_PROGRESS, locked ? 'Locking...' : 'Unlocking...');
  var stopNote = slowNote('Waiting for the car...');
  volvo.sendCommand(command, function(err, data) {
    stopNote();
    if (err) {
      console.log(command + ' failed: ' + err);
      if (createVolvo.isUncertain(err)) {
        verifyLock(locked, sentAt, err);
      } else {
        tellWatch(STATUS_ERROR, err);
      }
      return;
    }
    if (!locked && data.readyToUnlock && data.readyToUnlockUntil) {
      // The car unlocks only once a handle is touched, so its lock state stays as it was.
      tellWatch(STATUS_OK, 'Unlocked for ' + data.readyToUnlockUntil + ' s');
      followUp();
      return;
    }
    lockDone(locked, sentAt);
  });
}

// UP: lock an unlocked car, unlock a locked one. The car is asked first, so that the watch's
// picture of it, which may be old, does not decide.
function runToggle() {
  tellWatch(STATUS_PROGRESS, 'Checking lock...');
  volvo.getLock(function(err, lock) {
    if (err && (createVolvo.isLoginExpired(err) || !volvo.isConfigured())) {
      tellWatch(STATUS_ERROR, err);
      return;
    }
    var locked = err ? lockState.effective(null, null).locked
                     : lockState.effective(lock.locked, lock.lockedAt).locked;
    if (locked === null) {
      // Lock state unknown (no lock status scope, or Volvo did not answer): undo whatever the
      // last command did, and lock when there was none, as that is the safe way round.
      console.log('Lock state unknown' + (err ? ': ' + err : ''));
      locked = lockState.lastCommand() === true;
    }
    if (locked) {
      runUnlock(false);
    } else {
      run('lock');
    }
  });
}

function runExtra(id) {
  extras.run(String(id), function(text) {
    tellWatch(STATUS_PROGRESS, text);
  }, function(err, text, details) {
    if (err) {
      console.log(id + ' failed: ' + err);
      tellWatch(STATUS_ERROR, err);
    } else {
      tellWatch(STATUS_OK, text, details ? { Details: details } : {});
    }
  });
}

Pebble.addEventListener('ready', function() {
  Pebble.sendAppMessage({ JSReady: 1, Menu: extras.menu() });
  // Also fetches an access token up front, so the first button hold is quicker.
  refreshStatus();
  if (volvo.isConfigured() && unlockRange()) {
    proximity.prefetch();
  }
});

Pebble.addEventListener('appmessage', function(e) {
  var command = e.payload.Command;
  if (command === CMD_UNLOCK) {
    runUnlock(false);
  } else if (command === CMD_UNLOCK_ANYWAY) {
    runUnlock(true);
  } else if (command === CMD_LOCK) {
    run('lock');
  } else if (command === CMD_CLIMATE) {
    run('climate');
  } else if (command === CMD_TOGGLE) {
    runToggle();
  } else if (command === CMD_EXTRA) {
    runExtra(e.payload.Item);
  }
});

Pebble.addEventListener('showConfiguration', function() {
  // Show the current setup state at the top of the config page.
  // Clay works on its own copy of the config, so edit that one.
  clay.config.forEach(function(section) {
    (section.items || []).forEach(function(item) {
      if (item.id === 'status') {
        item.defaultValue = volvo.describe();
      }
    });
  });
  Pebble.openURL(clay.generateUrl());
});

function applySetupCode(code) {
  var err = volvo.importSetupCode(code);
  tellWatch(err ? STATUS_ERROR : STATUS_OK, err || 'Setup saved');
  if (!err) {
    refreshStatus();
  }
}

// The sign-in service finishes by opening pebblejs://close#<setup code>, which arrives here as
// the whole response instead of Clay's settings. Depending on how the link reached the Pebble
// app it may still be URL-encoded.
function setupCodeFromSignIn(response) {
  var text = String(response);
  try {
    text = decodeURIComponent(text);
  } catch (e) {
    // Not encoded.
  }
  return /^EX30K\d\.[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) {
    return;
  }
  var signInCode = setupCodeFromSignIn(e.response);
  if (signInCode) {
    applySetupCode(signInCode);
    return;
  }
  var settings;
  try {
    settings = clay.getSettings(e.response, false);
  } catch (err) {
    console.log('Unreadable settings response');
    return;
  }
  var code = settings.SetupCode && settings.SetupCode.value;
  // The code holds secrets; it is kept by volvo.js, not in Clay's visible settings.
  clay.setSettings('SetupCode', '');
  if (code && String(code).replace(/\s+/g, '')) {
    applySetupCode(code);
  }
});
