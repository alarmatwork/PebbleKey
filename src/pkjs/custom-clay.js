// Runs inside the settings page, not in PebbleKit JS: Clay copies this function's source into
// the page, so it can use nothing from outside its own body.
module.exports = function() {
  var clayConfig = this;

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function() {
    var button = clayConfig.getItemById('signin');
    var url = clayConfig.meta.userData.signInUrl;
    if (!button) {
      return;
    }
    if (!url) {
      // This build has no sign-in service; only the setup code route exists.
      button.hide();
      return;
    }
    button.on('click', function() {
      // The current Pebble app only lets a settings page leave for the phone's browser through
      // Pebble.openUrl; older apps let the page navigate there itself.
      if (window.Pebble && typeof window.Pebble.openUrl === 'function') {
        window.Pebble.openUrl(url);
      } else {
        window.location.href = url;
      }
    });
  });
};
