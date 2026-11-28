// The commands behind DOWN: a menu on the watch of things to read from the car or have it do.
// The watch shows only those the login's scopes allow, as long as the phone knows them.

var formatDistance = require('./proximity').formatDistance;
var chargeText = require('./volvo').chargeText;

// The longest text the watch keeps for the details screen (see src/c/main.c).
var DETAILS_MAX = 300;

var TYRE_OK = { NO_WARNING: true, UNSPECIFIED: true };

function isOpen(entry) {
  return !!entry && (entry.value === 'OPEN' || entry.value === 'AJAR');
}

// 12345 -> "12 345"
function groupDigits(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * @param {Object} deps
 * @param {Object} deps.volvo - from volvo.js
 * @param {Object} deps.proximity - from proximity.js
 * @param {Object} deps.lockState - from lockstate.js
 */
module.exports = function createExtras(deps) {
  var volvo = deps.volvo;
  var proximity = deps.proximity;
  var lockState = deps.lockState;

  // One line about the car each; cb(null, line) or cb(err). A part whose scope the login lacks
  // is skipped without asking Volvo.
  var INFO_PARTS = [
    {
      scopes: ['conve:doors_status', 'conve:lock_status'],
      read: function(cb) {
        volvo.getLock(function(err, lock) {
          if (err) {
            cb(err);
            return;
          }
          var locked = lockState.effective(lock.locked, lock.lockedAt).locked;
          var state = locked === true ? 'Locked' : locked === false ? 'Unlocked' : 'Lock unknown';
          cb(null, state + ', ' + (lock.open.length ? lock.open.join(' & ') + ' open' : 'all shut'));
        });
      }
    },
    {
      scopes: ['energy:state:read', 'conve:fuel_status', 'conve:battery_charge_level'],
      read: function(cb) {
        volvo.getStatus(function(err, status) {
          if (err || status.battery === null) {
            cb(err || 'No battery level');
            return;
          }
          var line = 'Battery ' + status.battery + '%' +
            (status.range ? ', ' + status.range.value + ' ' + status.range.unit : '');
          var charge = chargeText(status.charge).replace('\n', ', ');
          cb(null, line + (charge ? '\n' + charge : ''));
        });
      }
    },
    {
      scopes: ['conve:windows_status'],
      read: function(cb) {
        volvo.read('connected-vehicle', 'windows', function(err, data) {
          if (err) {
            cb(err);
            return;
          }
          var open = ['frontLeftWindow', 'frontRightWindow', 'rearLeftWindow', 'rearRightWindow']
            .filter(function(name) { return isOpen(data[name]); }).length;
          var parts = [];
          if (open) {
            parts.push(open === 1 ? '1 window open' : open + ' windows open');
          }
          if (isOpen(data.sunroof)) {
            parts.push('sunroof open');
          }
          cb(null, parts.length ? parts.join(', ').replace(/^./, function(c) { return c.toUpperCase(); })
                                : 'Windows shut');
        });
      }
    },
    {
      scopes: ['conve:tyre_status'],
      read: function(cb) {
        volvo.read('connected-vehicle', 'tyres', function(err, data) {
          if (err) {
            cb(err);
            return;
          }
          var names = { frontLeft: 'FL', frontRight: 'FR', rearLeft: 'RL', rearRight: 'RR' };
          var bad = Object.keys(names).filter(function(name) {
            return data[name] && data[name].value && !TYRE_OK[data[name].value];
          }).map(function(name) { return names[name]; });
          cb(null, bad.length ? 'Check tyres: ' + bad.join(' ') : 'Tyres OK');
        });
      }
    },
    {
      scopes: ['conve:odometer_status'],
      read: function(cb) {
        volvo.read('connected-vehicle', 'odometer', function(err, data) {
          var value = Number(!err && data.odometer && data.odometer.value);
          if (err || !value) {
            cb(err || 'No odometer');
            return;
          }
          var unit = String(data.odometer.unit || 'km').toLowerCase().indexOf('mi') === 0 ? 'mi' : 'km';
          cb(null, 'Odometer ' + groupDigits(value) + ' ' + unit);
        });
      }
    },
    {
      scopes: ['location:read'],
      read: function(cb) {
        proximity.locate(function(err, where) {
          cb(err, err ? null : 'Car ' + formatDistance(where.meters) + ' ' + where.direction);
        });
      }
    }
  ];

  function allowed(scopes) {
    return !scopes || scopes.some(function(scope) { return volvo.mayUse(scope); });
  }

  function carInfo(cb) {
    var parts = INFO_PARTS.filter(function(part) { return allowed(part.scopes); });
    var lines = [];
    var errors = [];
    var pending = parts.length;
    if (!pending) {
      cb('Nothing to read (scopes?)');
      return;
    }
    parts.forEach(function(part, i) {
      part.read(function(err, line) {
        if (err) {
          errors.push(err);
        } else {
          lines[i] = line;
        }
        pending -= 1;
        if (pending > 0) {
          return;
        }
        var text = lines.filter(Boolean).join('\n');
        if (!text) {
          cb(errors[0]);
          return;
        }
        cb(null, 'Car info', text.slice(0, DETAILS_MAX));
      });
    });
  }

  function findCar(cb) {
    proximity.locate(function(err, where) {
      if (err) {
        cb(err);
        return;
      }
      cb(null, where.meters < 30 ? 'Car is right here' :
        'Car is ' + formatDistance(where.meters) + ' ' + where.direction);
    });
  }

  function command(name, doneText) {
    return function(cb) {
      volvo.sendCommand(name, function(err) {
        cb(err, err ? null : doneText);
      });
    };
  }

  // In the order the watch lists them. `title` must stay short enough for the watch's menu.
  var ITEMS = [
    { id: 'info', title: 'Car info', progress: 'Reading car...', run: carInfo },
    { id: 'find', title: 'Find car', scopes: ['location:read'], progress: 'Finding car...', run: findCar },
    { id: 'flash', title: 'Flash lights', scopes: ['conve:honk_flash'], progress: 'Flashing...',
      run: command('flash', 'Lights flashed') },
    { id: 'honk', title: 'Honk & flash', scopes: ['conve:honk_flash'], progress: 'Honking...',
      run: command('honk-flash', 'Honked & flashed') }
  ];

  function available() {
    return ITEMS.filter(function(item) { return allowed(item.scopes); });
  }

  return {
    /** The menu as the watch reads it: one "id:title" per line. */
    menu: function() {
      return available().map(function(item) { return item.id + ':' + item.title; }).join('\n');
    },

    /**
     * Run a menu item.
     * @param {string} id
     * @param {function(string)} progress - called with a short text when it starts
     * @param {function(string|null, string=, string=)} cb - cb(errorText) or
     *   cb(null, resultText, detailsText)
     */
    run: function(id, progress, cb) {
      var item = available().filter(function(it) { return it.id === id; })[0];
      if (!item) {
        cb('Not available');
        return;
      }
      progress(item.progress);
      item.run(cb);
    }
  };
};
