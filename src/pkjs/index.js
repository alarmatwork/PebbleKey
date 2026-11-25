var Clay = require('@rebble/clay');
var clayConfig = require('./config.json');
var customClay = require('./custom-clay');
var brokerConfig = require('./broker.json');
var createVolvo = require('./volvo');
var createProximity = require('./proximity');

// Keep in sync with src/c/main.c.
var CMD_UNLOCK = 1;
var CMD_LOCK = 2;
var CMD_CLIMATE = 4;
var CMD_UNLOCK_ANYWAY = 5;
var STATUS_REFRESH_DELAY_MS = 8000;
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

// Ask Volvo what the car last reported and show it on the watch.
function refreshStatus() {
  if (!volvo.isConfigured()) {
    return;
  }
  volvo.getStatus(function(err, status) {
    if (err) {
      console.log('Status failed: ' + err);
      if (createVolvo.isLoginExpired(err)) {
        // Say so right away, rather than only once the user holds a button.
        tellWatch(STATUS_NOTICE, err);
      }
      return;
    }
    var state = createVolvo.watchStatus(status);
    Pebble.sendAppMessage({
      LockState: state.lock,
      Battery: state.battery,
      Info: state.open,
      Climate: volvo.climateIsOn() ? 1 : 0,
      Charging: state.charging,
      ChargeInfo: state.charge
    });
  });
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
  volvo.toggleClimate(function(err, isOn) {
    if (err) {
      console.log('climate failed: ' + err);
      tellWatch(STATUS_ERROR, err);
    } else {
      tellWatch(STATUS_OK, isOn ? 'Climate on' : 'Climate off', { Climate: isOn ? 1 : 0 });
    }
  });
}

function run(command) {
  if (command === 'climate') {
    runClimate();
    return;
  }
  tellWatch(STATUS_PROGRESS, command === 'lock' ? 'Locking...' : 'Unlocking...');
  volvo.sendCommand(command, function(err, data) {
    if (err) {
      console.log(command + ' failed: ' + err);
      tellWatch(STATUS_ERROR, err);
      return;
    }
    if (command === 'lock') {
      tellWatch(STATUS_OK, 'Locked', { LockState: LOCK_LOCKED });
    } else if (data.readyToUnlock && data.readyToUnlockUntil) {
      tellWatch(STATUS_OK, 'Unlocked for ' + data.readyToUnlockUntil + ' s');
    } else {
      tellWatch(STATUS_OK, 'Unlocked', { LockState: LOCK_UNLOCKED });
    }
    // Give the car a moment to report its new state before reading it back.
    setTimeout(refreshStatus, STATUS_REFRESH_DELAY_MS);
  });
}

Pebble.addEventListener('ready', function() {
  Pebble.sendAppMessage({ JSReady: 1 });
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
