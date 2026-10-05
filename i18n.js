/* Text lives alongside its translation in the static HTML. No fetch or build needed. */
(() => {
  'use strict';
  let language;
  try { language = localStorage.getItem('sozvon-site-lang'); } catch {}
  if (!['ru', 'en'].includes(language)) {
    const browserLanguage = navigator.languages?.[0] || navigator.language || 'ru';
    language = /^ru(?:-|$)/i.test(browserLanguage) ? 'ru' : 'en';
  }
  const entries = Array.from(document.querySelectorAll('[data-en]'), element => ({element, ru: element.innerHTML, en: element.dataset.en}));
  const attributes = Array.from(document.querySelectorAll('[data-en-label], [data-en-alt], [data-en-content]')).flatMap(element =>
    ['label', 'alt', 'content'].filter(type => element.hasAttribute('data-en-' + type)).map(type => {
      const attribute = type === 'label' ? 'aria-label' : type;
      return {element, attribute, ru: element.getAttribute(attribute), en: element.getAttribute('data-en-' + type)};
    }));
  function apply(next) {
    if (!['ru', 'en'].includes(next)) return;
    language = next;
    document.documentElement.lang = next;
    entries.forEach(entry => { entry.element.innerHTML = entry[next]; });
    attributes.forEach(entry => entry.element.setAttribute(entry.attribute, entry[next]));
    document.querySelectorAll('[data-lang-option]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.langOption === next)));
    document.dispatchEvent(new CustomEvent('sozvon:language', {detail: next}));
  }
  document.querySelectorAll('[data-lang-option]').forEach(button => button.addEventListener('click', () => {
    try { localStorage.setItem('sozvon-site-lang', button.dataset.langOption); } catch {}
    apply(button.dataset.langOption);
  }));
  window.SozvonI18n = {get language() { return language; }, set: apply};
  apply(language);
})();
