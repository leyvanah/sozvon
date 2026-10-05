/* Runs before styles: no theme flash, including when opened from disk. */
(() => {
  'use strict';
  const root = document.documentElement;
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  let preference = 'system';
  try { const saved = localStorage.getItem('sozvon-site-theme'); if (['system', 'dark', 'light'].includes(saved)) preference = saved; } catch {}
  function apply() {
    root.dataset.theme = preference === 'system' ? (media?.matches ? 'light' : 'dark') : preference;
    root.dataset.themePreference = preference;
    document.querySelectorAll('[data-theme-option]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeOption === preference)));
  }
  window.SozvonTheme = { set(value) {
    if (!['system', 'light', 'dark'].includes(value)) return;
    preference = value;
    try { localStorage.setItem('sozvon-site-theme', value); } catch {}
    apply();
  }};
  apply();
  if (media?.addEventListener) media.addEventListener('change', () => { if (preference === 'system') apply(); });
  else if (media?.addListener) media.addListener(() => { if (preference === 'system') apply(); });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-option]').forEach(button => button.addEventListener('click', () => window.SozvonTheme.set(button.dataset.themeOption)));
    apply();
  });
})();
