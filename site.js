(() => {
  'use strict';
  const text = (ru, en) => document.documentElement.lang === 'en' ? en : ru;
  const announcement = document.getElementById('announcement');
  document.querySelectorAll('[data-copy]').forEach(button => {
    let timer;
    button.addEventListener('click', async () => {
      const command = button.dataset.copy || button.closest('.codeblock').querySelector('code').textContent;
      let copied = false;
      try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(command); copied = true; } } catch {}
      if (!copied) {
        const field = document.createElement('textarea');
        field.value = command;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.append(field);
        field.select();
        try { copied = document.execCommand('copy'); } catch {}
        field.remove();
        button.focus({preventScroll: true});
      }
      clearTimeout(timer);
      button.textContent = copied ? text('Скопировано ✓', 'Copied ✓') : text('Выделите команду', 'Select the command');
      if (announcement) announcement.textContent = copied ? text('Команда скопирована.', 'Command copied.') : text('Не удалось скопировать. Выделите команду и скопируйте вручную.', 'Copy failed. Select the command and copy it manually.');
      timer = setTimeout(() => { button.textContent = text('Копировать', 'Copy'); }, 2400);
    });
  });
  document.querySelectorAll('[role="tablist"]').forEach(list => {
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    function activate(tab) {
      tabs.forEach(item => {
        const selected = item === tab;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
      });
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); activate(tabs[next]); tabs[next].focus(); }
      });
    });
    activate(tabs[0]);
  });
  const viewer = document.querySelector('.image-viewer');
  if (viewer && typeof viewer.showModal === 'function') {
    const image = viewer.querySelector('img');
    const caption = viewer.querySelector('.viewer-caption');
    const stage = viewer.querySelector('.viewer-stage');
    const sizeButton = viewer.querySelector('.viewer-size');
    let opener;
    function resetZoom() {
      stage.classList.remove('is-zoomed');
      sizeButton.setAttribute('aria-pressed', 'false');
      stage.scrollTop = stage.scrollLeft = 0;
    }
    function syncCaption() {
      if (!opener) return;
      image.alt = opener.querySelector('img').alt;
      caption.textContent = opener.closest('figure').querySelector('figcaption').textContent;
    }
    document.querySelectorAll('.screenshot-link').forEach(link => {
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        opener = link;
        image.src = link.href;
        syncCaption();
        resetZoom();
        viewer.showModal();
        document.body.classList.add('viewer-open');
      });
    });
    sizeButton.addEventListener('click', () => {
      const zoomed = stage.classList.toggle('is-zoomed');
      sizeButton.setAttribute('aria-pressed', String(zoomed));
      stage.scrollTop = stage.scrollLeft = 0;
    });
    viewer.querySelector('.viewer-close').addEventListener('click', () => viewer.close());
    viewer.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });
    viewer.addEventListener('close', () => {
      document.body.classList.remove('viewer-open');
      resetZoom();
      opener?.focus({preventScroll: true});
    });
    document.addEventListener('sozvon:language', syncCaption);
  }
  const menuButton = document.querySelector('.menu-button');
  const navigation = document.getElementById('navigation');
  function closeMenu() { menuButton?.setAttribute('aria-expanded', 'false'); navigation?.classList.remove('is-open'); }
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('is-open', open);
  });
  navigation?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') { closeMenu(); menuButton.focus(); } });
  const toc = Array.from(document.querySelectorAll('.toc a[href^="#"]')).map(link => ({link, heading: document.getElementById(link.hash.slice(1))})).filter(item => item.heading);
  let scheduled = false;
  function highlight() {
    let current = toc[0];
    for (const item of toc) { if (item.heading.getBoundingClientRect().top < 190) current = item; }
    toc.forEach(item => { if (item === current) item.link.setAttribute('aria-current', 'location'); else item.link.removeAttribute('aria-current'); });
    scheduled = false;
  }
  if (toc.length) {
    highlight();
    window.addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(highlight); } }, {passive: true});
    document.addEventListener('sozvon:language', highlight);
  }
})();
