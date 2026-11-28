// Checks whether the phone is roughly where the car is parked, so that an unlock sent from
// far away has to be confirmed on the watch first.

var EARTH_RADIUS_M = 6371000;
// The car's parked position rarely changes while the app is open.
var CAR_MAX_AGE_MS = 60000;
var PHONE_MAX_AGE_MS = 60000;
var PHONE_TIMEOUT_MS = 8000;

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

/** Great-circle distance in metres between two WGS84 points. */
function distanceMeters(lat1, lon1, lat2, lon2) {
  var dLat = toRadians(lat2 - lat1);
  var dLon = toRadians(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Compass direction from the first point to the second, e.g. 'NE'.
function direction(lat1, lon1, lat2, lon2) {
  var y = Math.sin(toRadians(lon2 - lon1)) * Math.cos(toRadians(lat2));
  var x = Math.cos(toRadians(lat1)) * Math.sin(toRadians(lat2)) -
    Math.sin(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.cos(toRadians(lon2 - lon1));
  var degrees = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];
}

function formatDistance(meters) {
  if (meters < 1000) {
    return Math.round(meters / 10) * 10 + ' m';
  }
  return (meters < 10000 ? Math.round(meters / 100) / 10 : Math.round(meters / 1000)) + ' km';
}

/**
 * @param {Object} deps
 * @param {Object} deps.volvo - needs getCarLocation(cb)
 * @param {Object} [deps.geolocation] - navigator.geolocation, if the runtime has it
 * @param {function} [deps.now]
 * @param {function} [deps.setTimeout]
 */
module.exports = function createProximity(deps) {
  var volvo = deps.volvo;
  var geolocation = deps.geolocation;
  var now = deps.now || function() { return Date.now(); };
  var later = deps.setTimeout || setTimeout;
  var carCache = null;

  function carLocation(cb) {
    if (carCache && now() - carCache.at < CAR_MAX_AGE_MS) {
      cb(null, carCache.point);
      return;
    }
    volvo.getCarLocation(function(err, point) {
      if (err) {
        console.log('Car location failed: ' + err);
        cb('No car location');
        return;
      }
      carCache = { at: now(), point: point };
      cb(null, point);
    });
  }

  function phoneLocation(cb) {
    if (!geolocation) {
      cb('No phone location');
      return;
    }
    var done = false;
    function finish(err, point) {
      if (!done) {
        done = true;
        cb(err, point);
      }
    }
    // Some runtimes never call back when location is switched off; don't wait forever.
    later(function() { finish('No phone location'); }, PHONE_TIMEOUT_MS + 2000);
    geolocation.getCurrentPosition(function(position) {
      finish(null, {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy || 0
      });
    }, function(error) {
      console.log('Phone location failed: ' + (error && error.message));
      // 1 is PERMISSION_DENIED.
      finish(error && error.code === 1 ? 'Allow location in Pebble app' : 'No phone location');
    }, { enableHighAccuracy: true, timeout: PHONE_TIMEOUT_MS, maximumAge: PHONE_MAX_AGE_MS });
  }

  /**
   * Where the car is, seen from the phone.
   * @param {function(string|null, Object=)} cb - cb(errorText) or cb(null, {meters,
   *   accuracy: of the phone's fix in metres, direction: e.g. 'NE'})
   */
  function locate(cb) {
    var car;
    var phone;
    var failure = null;
    var pending = 2;
    function done(err) {
      failure = failure || err;
      pending -= 1;
      if (pending > 0) {
        return;
      }
      if (failure) {
        cb(failure);
        return;
      }
      cb(null, {
        meters: distanceMeters(phone.lat, phone.lon, car.lat, car.lon),
        accuracy: phone.accuracy,
        direction: direction(phone.lat, phone.lon, car.lat, car.lon)
      });
    }
    carLocation(function(err, point) { car = point; done(err); });
    phoneLocation(function(err, point) { phone = point; done(err); });
  }

  /**
   * @param {number} limitMeters - how far from the car still counts as "at the car"
   * @param {function(Object)} cb - cb({near: true}) or cb({near: false, text: why})
   */
  function check(limitMeters, cb) {
    locate(function(err, where) {
      if (err) {
        cb({ near: false, text: err });
        return;
      }
      // Give an imprecise phone fix the benefit of the doubt, but never more than the limit
      // itself, so a very rough fix cannot make a far-away car count as near.
      var slack = Math.min(where.accuracy, limitMeters);
      if (where.meters - slack <= limitMeters) {
        cb({ near: true, meters: where.meters });
      } else {
        cb({ near: false, meters: where.meters, text: 'Car is ' + formatDistance(where.meters) + ' away' });
      }
    });
  }

  return {
    check: check,
    locate: locate,
    // Warm both lookups so a later check answers quickly.
    prefetch: function() {
      carLocation(function() {});
      phoneLocation(function() {});
    }
  };
};

module.exports.distanceMeters = distanceMeters;
module.exports.formatDistance = formatDistance;
module.exports.direction = direction;
