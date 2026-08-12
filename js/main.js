/* River City Realty — site scripts
   Deliberately small. CFR's main.js carries a delegated search handler that
   had to be worked around on that site; RCR starts clean, so there is nothing
   here but the mobile menu and the scroll reveal. */

(function () {
  'use strict';

  /* ── Mobile menu ─────────────────────────────────────────── */
  var menu = document.getElementById('mobileMenu');

  window.openMenu = function () {
    if (menu) { menu.classList.add('open'); document.body.style.overflow = 'hidden'; }
  };

  window.closeMenu = function () {
    if (menu) { menu.classList.remove('open'); document.body.style.overflow = ''; }
  };

  /* Close on Escape, and on any link tap inside the menu. */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.closeMenu();
  });

  if (menu) {
    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') window.closeMenu();
    });
  }

  /* ── Fade-in on scroll ───────────────────────────────────────
     Sections carry .fade-in. If IntersectionObserver is missing,
     everything is revealed immediately rather than left hidden. */
  var targets = document.querySelectorAll('.fade-in');

  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(targets, function (el) { el.classList.add('visible'); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -60px 0px', threshold: 0.05 });

  Array.prototype.forEach.call(targets, function (el) { io.observe(el); });
})();
