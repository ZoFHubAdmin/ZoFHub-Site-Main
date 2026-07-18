/* The keydown event occurs when a keyboard key is pressed down. */
$(document).keydown(function (event) {
  var charCode = event.keyCode;
  statusKeys[charCode] = true;
});

/* The keyup event occurs when a keyboard key is released. */
$(document).keyup(function (event) {
  var charCode = event.keyCode;
  statusKeys[charCode] = false;
});

/* ---------------------------------------------------------------------------
 * Mobile touch / swipe controls.
 * The game reads lane moves from statusKeys[37/65] (left) & [39/68] (right),
 * and jump from statusKeys[32]. A swipe just "presses" the matching key for a
 * moment; player_tick() consumes it on the next frame — no other code changes.
 *   swipe left  -> move left        swipe right -> move right
 *   swipe up    -> jump             tap         -> jump
 * ------------------------------------------------------------------------- */
(function () {
  var LEFT = 37, RIGHT = 39, JUMP = 32;

  function press(code, ms) {
    statusKeys[code] = true;
    setTimeout(function () { statusKeys[code] = false; }, ms || 120);
  }

  var sx = 0, sy = 0, tracking = false;
  var MIN_SWIPE = 24; // px of travel before a drag counts as a swipe

  function onStart(e) {
    var t = e.changedTouches ? e.changedTouches[0] : e;
    sx = t.clientX; sy = t.clientY; tracking = true;
  }

  function onEnd(e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches ? e.changedTouches[0] : e;
    var dx = t.clientX - sx, dy = t.clientY - sy;
    var ax = Math.abs(dx), ay = Math.abs(dy);

    if (Math.max(ax, ay) < MIN_SWIPE) { press(JUMP, 150); return; } // tap = jump
    if (ax > ay) { press(dx < 0 ? LEFT : RIGHT); }                  // horizontal swipe = lane change
    else if (dy < 0) { press(JUMP, 150); }                         // upward swipe = jump
  }

  var target = document.getElementById('glcanvas') || document;
  target.addEventListener('touchstart', onStart, { passive: true });
  target.addEventListener('touchend', onEnd, { passive: true });
  // Keep the page from scrolling/zooming while a finger is on the game.
  target.addEventListener('touchmove', function (e) {
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
})();
