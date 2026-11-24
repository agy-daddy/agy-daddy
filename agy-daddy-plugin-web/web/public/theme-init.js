(function () {
  var THEME_KEY = 'agy.web.theme';
  var COLOR_KEY = 'agy.web.colorTheme';
  var SPEED_KEY = 'agy.web.drawerSpeed';

  var pref = 'system';
  var colorTheme = 'monochrome';
  var drawerSpeed = 'normal';

  try {
    var savedTheme = window.localStorage.getItem(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      pref = savedTheme;
    }
    var savedColor = window.localStorage.getItem(COLOR_KEY);
    if (
      savedColor === 'monochrome' ||
      savedColor === 'purple' ||
      savedColor === 'blue' ||
      savedColor === 'green' ||
      savedColor === 'amber' ||
      savedColor === 'red'
    ) {
      colorTheme = savedColor;
    }
    var savedSpeed = window.localStorage.getItem(SPEED_KEY);
    if (
      savedSpeed === 'fast' ||
      savedSpeed === 'normal' ||
      savedSpeed === 'smooth' ||
      savedSpeed === 'off'
    ) {
      drawerSpeed = savedSpeed;
    }
  } catch (e) {}

  var resolved = pref;
  if (pref === 'system') {
    var prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    resolved = prefersDark ? 'dark' : 'light';
  }

  var speedMap = { fast: '120ms', normal: '200ms', smooth: '320ms', off: '0ms' };
  var root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  root.dataset.colorTheme = colorTheme;
  root.dataset.drawerSpeed = drawerSpeed;
  root.style.setProperty('--drawer-duration', speedMap[drawerSpeed] || '200ms');
})();
