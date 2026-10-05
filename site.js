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
  // The screenshot carousel in the hero.  The slides are a scroll-snap strip,
  // so a swipe on a touch screen is the browser's own; this adds the arrows,
  // a dot per slide, and moving on by itself every five seconds.  It holds
  // still while the pointer is over it or focus is inside it, while the page
  // or the carousel is out of sight, while a screenshot is open full size,
  // and for good once paused -- or from the start, for anyone who has asked
  // their system for less motion.  The pause button is what WCAG asks of
  // anything that moves on its own.
  const carousel = document.querySelector('.carousel');
  if (carousel) {
    const track = carousel.querySelector('.carousel-track');
    const slides = Array.from(track.querySelectorAll('.carousel-slide'));
    const dotsBox = carousel.querySelector('.carousel-dots');
    const pauseButton = carousel.querySelector('.carousel-pause');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const INTERVAL = 5000;
    let index = 0;
    let paused = reduceMotion.matches;
    let hovered = false, focused = false, visible = true;
    let timer;

    const dots = slides.map((slide, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-controls', track.id);
      dot.addEventListener('click', () => { go(i); restart(); });
      dotsBox.append(dot);
      return dot;
    });

    function label() {
      const n = slides.length;
      carousel.setAttribute('aria-roledescription', text('карусель', 'carousel'));
      dotsBox.setAttribute('aria-label', text('Выбор скриншота', 'Choose a screenshot'));
      slides.forEach((slide, i) => {
        const name = text(slide.dataset.nameRu, slide.dataset.nameEn);
        slide.setAttribute('aria-roledescription', text('слайд', 'slide'));
        slide.setAttribute('aria-label', text(`${i + 1} из ${n}: ${name}`, `${i + 1} of ${n}: ${name}`));
        dots[i].setAttribute('aria-label', text(`Скриншот ${i + 1}: ${name}`, `Screenshot ${i + 1}: ${name}`));
      });
      pauseButton.setAttribute('aria-label', paused
        ? text('Листать автоматически', 'Play automatically')
        : text('Остановить автоматическое листание', 'Stop moving automatically'));
    }

    // The slide in view, and the two after it, are loaded ahead of time so
    // that an automatic turn never lands on an empty frame.
    function mark() {
      dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)));
      slides.forEach((slide, i) => {
        slide.inert = i !== index;
        const ahead = (i - index + slides.length) % slides.length;
        const img = slide.querySelector('img');
        if (ahead <= 2 && img.loading === 'lazy') img.loading = 'eager';
      });
    }

    function go(i, instant) {
      index = (i + slides.length) % slides.length;
      track.scrollTo({left: index * track.clientWidth, behavior: instant || reduceMotion.matches ? 'auto' : 'smooth'});
      mark();
    }

    function running() {
      return !paused && !hovered && !focused && visible && !document.hidden && !document.body.classList.contains('viewer-open');
    }
    function restart() {
      clearTimeout(timer);
      // Polite announcements only while it is not moving by itself, or a
      // screen reader would be read a new slide every five seconds.
      track.setAttribute('aria-live', running() ? 'off' : 'polite');
      // Checked again when it fires: a screenshot may have been opened since.
      if (running()) timer = setTimeout(() => { if (running()) go(index + 1); restart(); }, INTERVAL);
    }

    carousel.querySelector('.carousel-prev').addEventListener('click', () => { go(index - 1); restart(); });
    carousel.querySelector('.carousel-next').addEventListener('click', () => { go(index + 1); restart(); });
    pauseButton.addEventListener('click', () => {
      paused = !paused;
      pauseButton.setAttribute('aria-pressed', String(paused));
      label();
      restart();
    });
    track.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        go(index + (event.key === 'ArrowRight' ? 1 : -1));
      }
    });

    // A swipe or a trackpad scroll moves the strip without us: follow it.
    let settle;
    track.addEventListener('scroll', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const at = Math.round(track.scrollLeft / track.clientWidth);
        if (at !== index) { index = at; mark(); restart(); }
      }, 120);
    }, {passive: true});
    // Keep the same slide in view when the strip changes width.
    new ResizeObserver(() => go(index, true)).observe(track);

    carousel.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') { hovered = true; restart(); } });
    carousel.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') { hovered = false; restart(); } });
    // Keyboard focus only: a mouse click leaves focus on the button it
    // pressed, and that must not stop the carousel for good.
    carousel.addEventListener('focusin', event => { focused = event.target.matches(':focus-visible'); restart(); });
    carousel.addEventListener('focusout', event => { if (!carousel.contains(event.relatedTarget)) { focused = false; restart(); } });
    document.addEventListener('visibilitychange', restart);
    document.querySelector('.image-viewer')?.addEventListener('close', () => setTimeout(restart));
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; restart(); }, {threshold: 0.4}).observe(carousel);
    document.addEventListener('sozvon:language', label);

    pauseButton.setAttribute('aria-pressed', String(paused));
    label();
    mark();
    restart();
  }
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
