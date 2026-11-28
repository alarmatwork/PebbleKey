// What the car's lock should be after a command, until the car reports it itself.
//
// Volvo answers a lock command once the car has locked, but the car reports its new lock state
// to Volvo a while later. Until then the status still says what it was before the command, so
// read back right away it would put the old state on the watch.

// Long after a command, whatever the car reports is the truth, even if it never got newer.
var EXPECT_MAX_MS = 3 * 60 * 1000;

/**
 * @param {Object} [deps]
 * @param {function} [deps.now] - returns the current time in ms
 */
module.exports = function createLockState(deps) {
  var now = (deps && deps.now) || function() { return Date.now(); };
  // {locked: boolean, at: ms when the command was sent}
  var expected = null;
  // What the last command that went through did: true locked, false unlocked, null none yet.
  var last = null;

  return {
    /**
     * A lock (true) or unlock (false) command went through.
     * @param {boolean} locked
     * @param {number} sentAt - when the command was sent, in ms
     */
    commandDone: function(locked, sentAt) {
      expected = { locked: locked, at: sentAt };
      last = locked;
    },

    /**
     * The lock state to show, given what the car reported.
     * @param {boolean|null} reported - the car's lock state, null if unknown
     * @param {number|null} reportedAt - when the car made that report, null if unknown
     * @returns {{locked: boolean|null, settled: boolean}} settled is false while the car has
     *   not yet reported anything since the last command
     */
    effective: function(reported, reportedAt) {
      if (expected && now() - expected.at > EXPECT_MAX_MS) {
        expected = null;
      }
      if (!expected) {
        return { locked: reported, settled: true };
      }
      // A report with no time on it is taken as new once it agrees with the command.
      var isNew = reportedAt !== null && reportedAt !== undefined ? reportedAt >= expected.at
                                                                 : reported === expected.locked;
      if (reported !== null && isNew) {
        // The car has spoken since the command: it may also have locked again by itself, or
        // been unlocked with the key.
        expected = null;
        return { locked: reported, settled: true };
      }
      return { locked: expected.locked, settled: false };
    },

    /** What the last command that went through did: true locked, false unlocked, or null. */
    lastCommand: function() {
      return last;
    }
  };
};
