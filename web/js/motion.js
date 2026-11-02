/* =============================================================================
 * motion.js — small, dependency-free motion helpers.
 *
 * Everything here degrades to "just set the value" when the user asks for
 * reduced motion; nothing is load-bearing for the app itself.
 * ========================================================================== */

const REDUCE = "(prefers-reduced-motion: reduce)";

export function reduced() {
  return window.matchMedia(REDUCE).matches;
}

/** Staggered entrance: nodes get `.in` one frame apart. */
export function reveal(nodes, { step = 45, base = 0 } = {}) {
  const list = [...nodes];
  if (reduced()) {
    list.forEach((n) => n.classList.add("in"));
    return;
  }
  list.forEach((node, i) => {
    node.style.setProperty("--i", String(i));
    setTimeout(() => node.classList.add("in"), base + i * step);
  });
}

/** Wrap each character in a span so CSS can stagger them. Idempotent. */
export function splitChars(el) {
  if (!el || el.dataset.split === "1") return;
  const text = el.textContent || "";
  el.dataset.split = "1";
  el.setAttribute("aria-label", text);
  el.textContent = "";
  [...text].forEach((ch, i) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.style.setProperty("--i", String(i));
    span.setAttribute("aria-hidden", "true");
    span.textContent = ch === " " ? "\u00a0" : ch;
    el.appendChild(span);
  });
}

/** Pull a button a few pixels toward the pointer while it is nearby. */
export function magnetic(el, { radius = 110, power = 6 } = {}) {
  if (!el || reduced()) return;
  let raf = 0;
  let target = { x: 0, y: 0 };

  const apply = () => {
    raf = 0;
    el.style.transform = `translate3d(${target.x.toFixed(2)}px, ${target.y.toFixed(2)}px, 0)`;
  };

  window.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    const reach = radius + Math.max(r.width, r.height) / 2;
    if (dist > reach) {
      target = { x: 0, y: 0 };
    } else {
      const falloff = 1 - dist / reach;
      target = { x: (dx / reach) * power * falloff * 2, y: (dy / reach) * power * falloff * 2 };
    }
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });

  el.addEventListener("pointerleave", () => {
    target = { x: 0, y: 0 };
    if (!raf) raf = requestAnimationFrame(apply);
  });
}

/** Odometer-ish count-up for the session stats. */
export function tick(el, to, format = (v) => String(Math.round(v))) {
  if (!el) return;
  const from = Number(el.dataset.value || 0);
  el.dataset.value = String(to);
  if (from === to) {
    el.textContent = format(to);
    return;
  }
  if (reduced()) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const dur = 520;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = format(to);
  };
  requestAnimationFrame(step);
}

/** Restart a one-shot CSS animation by toggling a class. */
export function pulse(el, cls = "pulse") {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

/** Short "flip" motion for swapped content (brand logo). */
export function swap(el) {
  pulse(el, "swap");
}

/** Cross-fade the canvas when the active photo changes. */
export function fade(canvas) {
  pulse(canvas, "canvas-in");
}
