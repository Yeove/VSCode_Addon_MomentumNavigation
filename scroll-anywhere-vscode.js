// scroll-anywhere-vscode.js
// Middle-mouse grab-and-drag scrolling with uniform-deceleration momentum for VS Code.
// Load via the "Custom CSS and JS Loader" extension (be5invis.vscode-custom-css)
// https://marketplace.visualstudio.com/items?itemName=be5invis.vscode-custom-css
//
// Original code lovingly forked (stolen) from the Firefox ScrollAnywhere extension
// https://addons.mozilla.org/firefox/addon/scroll_anywhere/
// GRAB_AND_DRAG mode + the UNIFORM momentum forumla (simpler than exponential decay. Because damn, am I bad at math)


(function () {
  "use strict";

  // ---- Tunables ----------------------------------------------------------
  const CONFIG = {
    dragButton: 1,            // 1 = middle mouse button (0=left, 2=right)
    dragMultiplier: 1.5,      // grab-and-drag. >2 scrolls faster than the hand moves
    flickMultiplier: 1.5,     // scales momentum/flick speed only; independent of grab-and-drag
    dragThreshold: 3,         // px of movement before a press counts as a drag
    momentumMultiplier: 900,  // ms of glide per (px/ms) of flick speed; higher = longer coast
    minMomentumSpeed: 0.02,   // px/ms; flicks slower than this just stop, no coast
    flickWindowMs: 50,        // measure release velocity over the last N ms of movement
    useCoalesced: true,       // sample sub-frame pointer events (high-Hz mice) when available
    onlyInScrollables: true,  // restrict to ".monaco-scrollable-element" panes
  };

  // ---- State -------------------------------------------------------------
  let target = null;     // element we dispatch wheel events at
  let active = false;    // pointer is down on a valid target
  let dragging = false;  // movement passed the threshold
  let lastX = 0, lastY = 0;
  let samples = [];      // recent {t, x, y} raw screen positions, within flickWindowMs
  let momentumId = 0;

  // Grab-and-drag: content follows the cursor, so the wheel delta is the
  // NEGATIVE of the drag delta. Monaco is virtualized and ignores scrollTop,
  // but it honors synthesized wheel events.
  const scroll = (dx, dy) => {
    if (!target) return;
    target.dispatchEvent(new WheelEvent("wheel", {
      deltaX: dx,
      deltaY: dy,
      deltaMode: 0,        // pixels
      bubbles: true,
      cancelable: true,
    }));
  };

  const stopMomentum = () => {
    if (momentumId) cancelAnimationFrame(momentumId);
    momentumId = 0;
  };

  // Keep a time-bounded ring of raw positions; drop anything older than the window.
  const recordSample = (x, y, t) => {
    samples.push({ t, x, y });
    const cutoff = t - CONFIG.flickWindowMs;
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
  };

  const onMouseDown = (e) => {
    if (e.button !== CONFIG.dragButton) return;
    const scrollable = e.target.closest && e.target.closest(".monaco-scrollable-element");
    if (CONFIG.onlyInScrollables && !scrollable) return;
    stopMomentum();
    // Aim at the stable scroll container, not the line node under the cursor (whoops)
    // since vertical scrolling recycles/detaches line DOM, which would silently kill
    // momentum mid-coast. The scrollable container persists.
    target = scrollable || e.target;
    active = true;
    dragging = false;
    lastX = e.screenX;
    lastY = e.screenY;
    samples = [];
    e.preventDefault();    // suppress native middle-click, or autoscroll/paste for linux
    e.stopPropagation();
    // pointermove gives us getCoalescedEvents(); mouseup is fine for release?
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  };

  const onPointerMove = (e) => {
    if (!active) return;
    // One net scroll per event: the display only repaints per frame, so scrolling
    // more often than that is invisible. The event's position is already the
    // coalesced endpoint, so a single delta covers all sub-frame movement.
    const dx = (e.screenX - lastX) * CONFIG.dragMultiplier;
    const dy = (e.screenY - lastY) * CONFIG.dragMultiplier;
    lastX = e.screenX;
    lastY = e.screenY;

    if (!dragging && Math.hypot(dx, dy) < CONFIG.dragThreshold) return;
    dragging = true;

    // Velocity, though it wants the fine-grained sub-frame trail when available which is preferred for high-Hz mice for ye old' gamers sake. Coarse event is only used as a fallback
    const fine = CONFIG.useCoalesced && e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (fine && fine.length) {
      for (const ce of fine) recordSample(ce.screenX, ce.screenY, ce.timeStamp);
    } else {
      recordSample(e.screenX, e.screenY, e.timeStamp || performance.now());
    }

    scroll(dx, dy);
  };

  const onMouseUp = () => {
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    active = false;
    if (dragging) {
      // Eats the auxclick that a middle release fires, this way mouse flick doesn't paste.
      const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
      window.addEventListener("auxclick", swallow, { capture: true, once: true });
      startMomentum();
    }
    dragging = false;
  };

  // Raw hand velocity (px/ms per axis) over the sample window: net displacement divided by net time. Endpoint-based, so it's rate-independent and self-smoothing.
  const flickVelocity = () => {
    if (samples.length < 2) return [0, 0];
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return [0, 0];
    return [(b.x - a.x) / dt, (b.y - a.y) / dt];
  };

  // UNIFORM momentum: displacement x(t) = v0*t - 0.5*a*t^2, with a = v0/duration,
  // so velocity falls linearly to exactly zero @ t = duration.
  const startMomentum = () => {
    const [rawX, rawY] = flickVelocity();
    const dragVX = rawX * CONFIG.dragMultiplier;   // match the on-screen drag speed, or that's what it's supposed to do, but feels slower?
    const dragVY = rawY * CONFIG.dragMultiplier;
    if (Math.hypot(dragVX, dragVY) < CONFIG.minMomentumSpeed) return;

    const vx = dragVX * CONFIG.flickMultiplier;
    const vy = dragVY * CONFIG.flickMultiplier;
    const speed = Math.hypot(vx, vy);

    const duration = speed * CONFIG.momentumMultiplier; // ms; shared by both x & y axes
    const ax = vx / duration;
    const ay = vy / duration;
    const start = performance.now();
    let prevX = 0, prevY = 0;

    const step = (now) => {
      const t = now - start;
      if (t >= duration) { stopMomentum(); return; }
      const x = vx * t - 0.5 * ax * t * t;
      const y = vy * t - 0.5 * ay * t * t;
      scroll(x - prevX, y - prevY);
      prevX = x;
      prevY = y;
      momentumId = requestAnimationFrame(step);
    };
    momentumId = requestAnimationFrame(step);
  };

  window.addEventListener("mousedown", onMouseDown, true);
})();
