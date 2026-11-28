// Volvo Connected Vehicle API client for the phone side (PebbleKit JS).
// Written in ES5 with callbacks so it runs in every PebbleKit JS runtime.
//
// Endpoints and flow follow https://developer.volvocars.com/apis/docs/authorisation
// and .../connected-vehicle/v2/endpoints/doors-windows-locks, .../location/v1/endpoints/location,
// .../energy/v2/endpoints/energy-state

var TOKEN_URL = 'https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/token';
var API_HOST = 'https://api.volvocars.com/';
var CONNECTED_VEHICLE = 'connected-vehicle/v2';
var LOCATION = 'location/v1';
var ENERGY = 'energy/v2';

// Two kinds of setup code:
//   EX30K1 comes from tools/volvo_login.py and carries your own Volvo application's client
//          secret, so the phone refreshes its login directly with Volvo.
//   EX30K2 comes from a sign-in service (broker/) and carries no secret; the phone asks that
//          service to refresh its login.
var SETUP_PREFIX = 'EX30K1.';
var BROKER_SETUP_PREFIX = 'EX30K2.';
var CREDS_KEY = 'ex30-creds';
var TOKENS_KEY = 'ex30-tokens';
var CLIMATE_KEY = 'ex30-climate';

var HTTP_TIMEOUT_MS = 30000;
// Volvo answers a car command only once the car has carried it out, or given up on it. A car
// that has to wake up first can take well over a minute, climate in particular.
var COMMAND_TIMEOUT_MS = 110000;
// Refresh this long before the access token actually expires.
var EXPIRY_MARGIN_MS = 30000;
// The car ends a remote climate run by itself after this long. Volvo's API has no way to ask
// whether climate is running, so the toggle goes by what this app last did.
var CLIMATE_RUN_MS = 30 * 60 * 1000;
// A login made before this app asked for the energy scope is refused by the Energy API. That
// stays so until the user signs in again, so the app asks again only this often.
var ENERGY_RETRY_MS = 24 * 60 * 60 * 1000;

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(str) {
  var out = '';
  for (var i = 0; i < str.length; i += 3) {
    var a = str.charCodeAt(i);
    var b = str.charCodeAt(i + 1);
    var c = str.charCodeAt(i + 2);
    out += B64.charAt(a >> 2);
    out += B64.charAt(((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4));
    out += isNaN(b) ? '=' : B64.charAt(((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6));
    out += isNaN(c) ? '=' : B64.charAt(c & 63);
  }
  return out;
}

// Accepts both standard and URL-safe alphabets, with or without padding.
function base64Decode(input) {
  var clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var out = '';
  var bits = 0;
  var acc = 0;
  for (var i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 255);
    }
  }
  return out;
}

var INVOKE_ERRORS = {
  TIMEOUT: 'Car did not answer',
  UNKNOWN: 'Car did not confirm',
  CONNECTION_FAILURE: 'Car is offline',
  VEHICLE_IN_SLEEP: 'Car is asleep',
  UNABLE_TO_LOCK_DOOR_OPEN: 'A door is open',
  UNLOCK_TIME_FRAME_PASSED: 'Unlock window passed',
  REJECTED: 'Car rejected it',
  CAR_ERROR: 'Car reported an error',
  NOT_ALLOWED_PRIVACY_ENABLED: 'Privacy mode is on',
  NOT_ALLOWED_WRONG_USAGE_MODE: 'Car is in use'
};

var NOT_ALLOWED = 'Not allowed (scopes?)';
var VOLVO_NO_ANSWER = 'Volvo did not answer';
// Volvo no longer accepts the login: after 3 months at the latest, the user has to sign in again.
var LOGIN_EXPIRED_SIGN_IN = 'Login expired, sign in again';
var LOGIN_EXPIRED_OWN_KEYS = 'Login expired, redo setup';

var HTTP_ERRORS = {
  400: 'Bad request',
  403: NOT_ALLOWED,
  404: 'Car not found (VIN?)',
  415: 'Bad content type',
  422: 'Not supported by car',
  429: 'Too many requests',
  504: VOLVO_NO_ANSWER
};

// Failures after which a command may well have reached the car anyway: nobody heard back from
// the car in time, so the outcome is not known.
var UNCERTAIN_ERRORS = [VOLVO_NO_ANSWER, INVOKE_ERRORS.TIMEOUT, INVOKE_ERRORS.UNKNOWN];

/**
 * @param {Object} deps
 * @param {function} deps.XMLHttpRequest - XHR constructor
 * @param {Object} deps.storage - localStorage-like object
 * @param {function} [deps.now] - returns the current time in ms
 * @param {string} [deps.brokerUrl] - sign-in service this build uses, if any
 */
module.exports = function createVolvo(deps) {
  var XHR = deps.XMLHttpRequest;
  var storage = deps.storage;
  var brokerUrl = String(deps.brokerUrl || '').replace(/\/+$/, '');
  var now = deps.now || function() { return Date.now(); };

  // Callbacks waiting on a token refresh that is already in flight.
  var refreshWaiters = null;

  function load(key) {
    try {
      return JSON.parse(storage.getItem(key)) || null;
    } catch (e) {
      return null;
    }
  }

  function save(key, value) {
    storage.setItem(key, JSON.stringify(value));
  }

  function http(method, url, headers, body, cb, timeout) {
    var xhr = new XHR();
    var done = false;
    function finish(status, text) {
      if (done) {
        return;
      }
      done = true;
      cb(status, text || '');
    }
    xhr.open(method, url, true);
    for (var name in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, name)) {
        xhr.setRequestHeader(name, headers[name]);
      }
    }
    xhr.timeout = timeout || HTTP_TIMEOUT_MS;
    xhr.onload = function() { finish(xhr.status, xhr.responseText); };
    // Status 0 means no HTTP answer; the text then says why. The Pebble phone app marks a
    // request it refused (internet permission not granted for this watchapp) with _notAllowed.
    xhr.onerror = function() { finish(0, xhr._notAllowed ? 'blocked' : 'network'); };
    xhr.ontimeout = function() { finish(0, 'timeout'); };
    xhr.send(body);
  }

  function noAnswerMessage(reason) {
    if (reason === 'blocked') {
      return 'Allow internet in Pebble app';
    }
    return reason === 'timeout' ? VOLVO_NO_ANSWER : 'No internet on phone';
  }

  function parseJson(text) {
    try {
      return JSON.parse(text) || {};
    } catch (e) {
      return {};
    }
  }

  function isConfigured() {
    var creds = load(CREDS_KEY);
    var tokens = load(TOKENS_KEY);
    return !!(creds && tokens && tokens.refreshToken);
  }

  function describe() {
    var creds = load(CREDS_KEY);
    if (!isConfigured()) {
      return 'Not set up yet.';
    }
    return (creds.broker ? 'Signed in with Volvo' : 'Set up with your own keys') +
      ', car VIN ending ' + creds.vin.slice(-6) + '.';
  }

  /**
   * Store credentials from a setup code: one printed by tools/volvo_login.py, or one handed
   * over by the sign-in service.
   * @returns {string|null} an error message, or null on success
   */
  function importSetupCode(code) {
    code = String(code || '').replace(/\s+/g, '');
    var viaBroker = code.indexOf(BROKER_SETUP_PREFIX) === 0;
    if (!viaBroker && code.indexOf(SETUP_PREFIX) !== 0) {
      return 'Not a setup code';
    }
    if (viaBroker && !brokerUrl) {
      return 'This build has no sign-in';
    }
    var data;
    try {
      data = JSON.parse(base64Decode(code.slice(SETUP_PREFIX.length)));
    } catch (e) {
      return 'Setup code is damaged';
    }
    if (!data || !data.k || !data.v || !data.r || (!viaBroker && (!data.i || !data.s))) {
      return 'Setup code incomplete';
    }
    var creds = { apiKey: data.k, vin: String(data.v).toUpperCase() };
    if (viaBroker) {
      creds.broker = true;
    } else {
      creds.clientId = data.i;
      creds.clientSecret = data.s;
    }
    save(CREDS_KEY, creds);
    save(TOKENS_KEY, { refreshToken: data.r, accessToken: null, expiresAt: 0 });
    return null;
  }

  function refresh(cb) {
    if (refreshWaiters) {
      refreshWaiters.push(cb);
      return;
    }
    refreshWaiters = [cb];
    function settle(err, token) {
      var waiters = refreshWaiters;
      refreshWaiters = null;
      for (var i = 0; i < waiters.length; i++) {
        waiters[i](err, token);
      }
    }

    var creds = load(CREDS_KEY);
    var tokens = load(TOKENS_KEY);
    var url = TOKEN_URL;
    var headers = { 'content-type': 'application/x-www-form-urlencoded' };
    var body = 'refresh_token=' + encodeURIComponent(tokens.refreshToken);
    if (creds.broker) {
      if (!brokerUrl) {
        settle('This build has no sign-in');
        return;
      }
      // The sign-in service holds the client secret and adds it on the way to Volvo.
      url = brokerUrl + '/refresh';
    } else {
      body = 'grant_type=refresh_token&' + body;
      headers.authorization = 'Basic ' + base64Encode(
        encodeURIComponent(creds.clientId) + ':' + encodeURIComponent(creds.clientSecret));
    }

    http('POST', url, headers, body, function(status, text) {
      var json = parseJson(text);
      if (status === 200 && json.access_token) {
        if (creds.broker && json.api_key && json.api_key !== creds.apiKey) {
          // The service's operator replaced the Volvo API key.
          creds.apiKey = json.api_key;
          save(CREDS_KEY, creds);
        }
        // Volvo rotates the refresh token on every use: the old one is dead now,
        // so persist the new one before doing anything else.
        save(TOKENS_KEY, {
          refreshToken: json.refresh_token || tokens.refreshToken,
          accessToken: json.access_token,
          expiresAt: now() + (json.expires_in || 60) * 1000,
          // What the login may do, e.g. "openid conve:lock ...". Older sign-in services do
          // not pass it on, and then it stays unknown.
          scope: typeof json.scope === 'string' ? json.scope : tokens.scope || null
        });
        settle(null, json.access_token);
      } else if (status === 0) {
        settle(noAnswerMessage(text));
      } else if (creds.broker) {
        // The service answers invalid_grant only when Volvo no longer accepts the login.
        settle(json.error === 'invalid_grant' ? LOGIN_EXPIRED_SIGN_IN :
          'Sign-in service error ' + status);
      } else if (status === 400 || status === 401) {
        // invalid_grant: refresh token expired or already used; invalid_client: bad secret.
        settle(json.error === 'invalid_client' ? 'Bad client secret' : LOGIN_EXPIRED_OWN_KEYS);
      } else {
        settle('Volvo login error ' + status);
      }
    });
  }

  function getAccessToken(cb) {
    if (!isConfigured()) {
      cb('Set up in Pebble app');
      return;
    }
    var tokens = load(TOKENS_KEY);
    if (tokens.accessToken && tokens.expiresAt - EXPIRY_MARGIN_MS > now()) {
      cb(null, tokens.accessToken);
      return;
    }
    refresh(cb);
  }

  function forgetAccessToken() {
    var tokens = load(TOKENS_KEY);
    if (tokens) {
      tokens.accessToken = null;
      tokens.expiresAt = 0;
      save(TOKENS_KEY, tokens);
    }
  }

  /**
   * Authenticated call to the car's API, with one retry on a rejected token.
   * @param {string} method - 'GET' or 'POST'
   * @param {string} service - CONNECTED_VEHICLE, LOCATION or ENERGY
   * @param {string} path - path below /vehicles/{vin}/
   * @param {function(string|null, Object=)} cb - cb(errorText) or cb(null, responseData)
   * @param {Object} [opts] - timeout: ms to wait for the answer; retried: set on the retry
   */
  function api(method, service, path, cb, opts) {
    opts = opts || {};
    getAccessToken(function(err, token) {
      if (err) {
        cb(err);
        return;
      }
      var creds = load(CREDS_KEY);
      var headers = {
        'accept': 'application/json',
        'authorization': 'Bearer ' + token,
        'vcc-api-key': creds.apiKey
      };
      var body = null;
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        body = '{}';
      }
      var url = API_HOST + service + '/vehicles/' + encodeURIComponent(creds.vin) + '/' + path;
      http(method, url, headers, body,
        function(status, text) {
          if (status === 401 && !opts.retried) {
            // The cached token was rejected; get a fresh one and try once more.
            forgetAccessToken();
            api(method, service, path, cb, { timeout: opts.timeout, retried: true });
          } else if (status === 0) {
            cb(noAnswerMessage(text));
          } else if (status < 200 || status >= 300) {
            cb(HTTP_ERRORS[status] || ('Volvo error ' + status));
          } else {
            // The Energy API answers with the values themselves, the others wrap them in `data`.
            var json = parseJson(text);
            cb(null, json.data || json);
          }
        }, opts.timeout);
    });
  }

  /**
   * The scopes the login was granted, or null while that is not known.
   * @returns {string[]|null}
   */
  function grantedScopes() {
    var tokens = load(TOKENS_KEY);
    return tokens && typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : null;
  }

  /** Whether the login may use `scope`; true while the granted scopes are not known. */
  function mayUse(scope) {
    var scopes = grantedScopes();
    return !scopes || scopes.indexOf(scope) !== -1;
  }

  /**
   * Read any resource of the car.
   * @param {string} service - 'connected-vehicle', 'energy' or 'location'
   * @param {string} path - path below /vehicles/{vin}/, e.g. 'odometer'
   * @param {function(string|null, Object=)} cb
   */
  function read(service, path, cb) {
    var services = { 'connected-vehicle': CONNECTED_VEHICLE, energy: ENERGY, location: LOCATION };
    api('GET', services[service], path, cb);
  }

  /**
   * @param {string} command - 'lock', 'unlock', 'climatization-start', 'climatization-stop',
   *   'flash', 'honk-flash', ...
   * @param {function(string|null, Object=)} cb - cb(errorText) or cb(null, data); see
   *   isUncertain() for errors after which the car may have carried the command out anyway
   */
  function sendCommand(command, cb) {
    api('POST', CONNECTED_VEHICLE, 'commands/' + command, function(err, data) {
      if (err) {
        cb(err);
        return;
      }
      var invoke = data.invokeStatus;
      // RUNNING and WAITING are what climate commands report while the car carries them out.
      if (invoke === 'COMPLETED' || invoke === 'DELIVERED' ||
          invoke === 'RUNNING' || invoke === 'WAITING') {
        cb(null, data);
      } else {
        cb(INVOKE_ERRORS[invoke] || ('Failed: ' + (invoke || 'no status')));
      }
    }, { timeout: COMMAND_TIMEOUT_MS });
  }

  function isOpen(entry) {
    return !!entry && (entry.value === 'OPEN' || entry.value === 'AJAR');
  }

  function timeOf(entry) {
    var at = entry && entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    return isNaN(at) ? null : at;
  }

  /**
   * Lock state and what is open, as the car last reported them.
   * @param {function(string|null, Object=)} cb - cb(errorText) or cb(null, {locked:
   *   boolean|null, lockedAt: ms of that report or null, open: string[]})
   */
  function getLock(cb) {
    api('GET', CONNECTED_VEHICLE, 'doors', function(err, data) {
      if (err) {
        cb(err);
        return;
      }
      var lock = data.centralLock && data.centralLock.value;
      var open = [];
      if (isOpen(data.frontLeftDoor) || isOpen(data.frontRightDoor) ||
          isOpen(data.rearLeftDoor) || isOpen(data.rearRightDoor)) {
        open.push('door');
      }
      if (isOpen(data.tailgate)) {
        open.push('boot');
      }
      if (isOpen(data.hood)) {
        open.push('hood');
      }
      cb(null, {
        locked: lock === 'LOCKED' ? true : lock === 'UNLOCKED' ? false : null,
        lockedAt: timeOf(data.centralLock),
        open: open
      });
    });
  }

  // The value of one Energy API resource, or null if the car could not supply it.
  function energyValue(entry) {
    return entry && entry.status !== 'ERROR' && entry.value !== undefined ? entry.value : null;
  }

  function percentOrNull(value) {
    var percent = Number(value);
    return value === null || value === undefined || isNaN(percent) ? null : Math.round(percent);
  }

  // Charging as the Energy API reports it, or null when there is nothing to show.
  function chargeFrom(data) {
    var state = energyValue(data.chargingStatus);
    if (state !== 'CHARGING' && state !== 'DONE' && state !== 'SCHEDULED') {
      return null;
    }
    if (state !== 'CHARGING' && energyValue(data.chargerConnectionStatus) === 'DISCONNECTED') {
      return null;
    }
    var minutes = Number(energyValue(data.estimatedChargingTimeToTargetBatteryChargeLevel));
    var target = percentOrNull(energyValue(data.targetBatteryChargeLevel));
    return {
      state: state,
      minutes: state === 'CHARGING' && minutes > 0 ? Math.round(minutes) : null,
      target: target !== null && target > 0 && target <= 100 ? target : null
    };
  }

  /**
   * Battery level and charging from the Energy API.
   * @param {function(Object|null)} cb - cb({battery: number|null, range: {value, unit}|null,
   *   charge: Object|null}), or
   *   cb(null) when the Energy API could not be read
   */
  function getEnergy(cb) {
    var deniedAt = (load(CREDS_KEY) || {}).energyDeniedAt;
    if (deniedAt && now() - deniedAt < ENERGY_RETRY_MS) {
      cb(null);
      return;
    }
    api('GET', ENERGY, 'state', function(err, data) {
      if (err) {
        var creds = load(CREDS_KEY);
        if (err === NOT_ALLOWED && creds) {
          creds.energyDeniedAt = now();
          save(CREDS_KEY, creds);
        }
        cb(null);
        return;
      }
      var range = Number(energyValue(data.electricRange));
      cb({
        battery: percentOrNull(energyValue(data.batteryChargeLevel)),
        range: energyValue(data.electricRange) === null || isNaN(range) ? null : {
          value: Math.round(range),
          unit: (data.electricRange.unit || 'km').toLowerCase() === 'mi' ? 'mi' : 'km'
        },
        charge: chargeFrom(data)
      });
    });
  }

  /**
   * What the car last reported. Each part needs its own scopes on the Volvo application, so a
   * part that cannot be read is left null rather than failing the whole status.
   * @param {function(string|null, Object=)} cb - cb(errorText) only if nothing could be read,
   *   else cb(null, {locked: boolean|null, lockedAt: number|null, open: string[]|null,
   *   battery: number|null, range: {value, unit}|null,
   *   charge: {state: string, minutes: number|null, target: number|null}|null})
   */
  function getStatus(cb) {
    var status = { locked: null, lockedAt: null, open: null, battery: null, range: null, charge: null };
    var pending = 2;
    var errors = [];
    function done(err) {
      if (err) {
        errors.push(err);
      }
      pending -= 1;
      if (pending === 0) {
        cb(errors.length === 2 ? errors[0] : null, status);
      }
    }

    getLock(function(err, lock) {
      if (!err) {
        status.locked = lock.locked;
        status.lockedAt = lock.lockedAt;
        status.open = lock.open;
      }
      done(err);
    });

    // The Energy API gives the battery level and charging in one call. Without it (an older
    // login, or a car it does not cover) the battery level comes from the Connected Vehicle API.
    getEnergy(function(energy) {
      if (energy) {
        status.battery = energy.battery;
        status.range = energy.range;
        status.charge = energy.charge;
      }
      if (status.battery !== null) {
        done(null);
        return;
      }
      api('GET', CONNECTED_VEHICLE, 'fuel', function(err, data) {
        if (!err) {
          status.battery = percentOrNull(data.batteryChargeLevel && data.batteryChargeLevel.value);
        }
        done(err);
      });
    });
  }

  /**
   * Where the car was last parked.
   * @param {function(string|null, Object=)} cb - cb(errorText) or cb(null, {lat, lon})
   */
  function getCarLocation(cb) {
    api('GET', LOCATION, 'location', function(err, data) {
      // GeoJSON order: longitude first.
      var coords = !err && data.geometry && data.geometry.coordinates;
      if (err || !coords || isNaN(Number(coords[0])) || isNaN(Number(coords[1]))) {
        cb(err || 'Car location unknown');
        return;
      }
      cb(null, { lat: Number(coords[1]), lon: Number(coords[0]) });
    });
  }

  /** Whether this app started climate recently enough that it should still be running. */
  function climateIsOn() {
    var state = load(CLIMATE_KEY);
    return !!(state && state.on && now() - state.startedAt < CLIMATE_RUN_MS);
  }

  /**
   * Stop climate if this app believes it is running, otherwise start it.
   * @param {function(string|null, boolean=, boolean=)} cb - cb(errorText), or
   *   cb(null, isNowOn, unconfirmed): unconfirmed is set when the car did not confirm in time.
   *   It usually carries the command out all the same, so that counts as done.
   */
  function toggleClimate(cb) {
    var turnOn = !climateIsOn();
    sendCommand(turnOn ? 'climatization-start' : 'climatization-stop', function(err) {
      if (err && !isUncertain(err)) {
        cb(err);
        return;
      }
      save(CLIMATE_KEY, { on: turnOn, startedAt: now() });
      cb(null, turnOn, !!err);
    });
  }

  return {
    isConfigured: isConfigured,
    describe: describe,
    importSetupCode: importSetupCode,
    getAccessToken: getAccessToken,
    grantedScopes: grantedScopes,
    mayUse: mayUse,
    read: read,
    sendCommand: sendCommand,
    getLock: getLock,
    getStatus: getStatus,
    getCarLocation: getCarLocation,
    climateIsOn: climateIsOn,
    toggleClimate: toggleClimate
  };
};

// 45 -> "45 min", 80 -> "1 h 20 min", 120 -> "2 h"
function duration(minutes) {
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  if (!hours) {
    return rest + ' min';
  }
  return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
}

// The lines the watch shows while idle, e.g. "Charging to 80%\n1 h 20 min left", or ''.
function chargeText(charge) {
  if (!charge) {
    return '';
  }
  if (charge.state === 'DONE') {
    return 'Charging done';
  }
  if (charge.state === 'SCHEDULED') {
    return 'Charging scheduled';
  }
  return 'Charging' + (charge.target ? ' to ' + charge.target + '%' : '') +
    (charge.minutes ? '\n' + duration(charge.minutes) + ' left' : '');
}

/**
 * The car's state in the form the watch draws it.
 * @param {Object} status - result of getStatus()
 * @returns {{lock: number, battery: number, open: string, charging: number, charge: string}}
 *   lock is 0 unknown, 1 locked, 2 unlocked; battery is a percentage or -1; open names what is
 *   open, e.g. "Boot open", or ''; charging is 1 while the car charges; charge is the text
 *   about charging, or ''
 */
function watchStatus(status) {
  var open = '';
  if (status.open && status.open.length) {
    var what = status.open.length === 1 ? status.open[0] : 'car';
    open = what.charAt(0).toUpperCase() + what.slice(1) + ' open';
  }
  var battery = status.battery;
  return {
    lock: status.locked === null ? 0 : status.locked ? 1 : 2,
    battery: battery === null ? -1 : Math.max(0, Math.min(100, battery)),
    open: open,
    charging: status.charge && status.charge.state === 'CHARGING' ? 1 : 0,
    charge: chargeText(status.charge)
  };
}

/** Whether a command that failed with this error text may have reached the car anyway. */
function isUncertain(err) {
  return UNCERTAIN_ERRORS.indexOf(err) !== -1;
}

/** Whether an error text from this module means that the user has to sign in again. */
function isLoginExpired(err) {
  return err === LOGIN_EXPIRED_SIGN_IN || err === LOGIN_EXPIRED_OWN_KEYS;
}

module.exports.watchStatus = watchStatus;
module.exports.isLoginExpired = isLoginExpired;
module.exports.isUncertain = isUncertain;
module.exports.chargeText = chargeText;
module.exports.base64Encode = base64Encode;
module.exports.base64Decode = base64Decode;
