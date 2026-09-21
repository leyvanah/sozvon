// A knock notification's own page.  See src/knocks.js for what puts it on
// screen and why it is a window of ours rather than a system notification.
//
// The sentence and the buttons come from the web client, already translated
// (see hostKnock in static/galene.js).  Nothing is composed here: this page
// would otherwise hold a second, quietly diverging copy of what a knock says
// -- in one language, while the client speaks two.

(() => {
  const $text = document.getElementById('text');
  const $actions = document.getElementById('actions');
  const $close = document.getElementById('close');

  /** Ask for a window exactly as tall as what we drew. */
  function measure() {
    const card = document.getElementById('card');
    // Two frames: one for the layout to settle, one for fonts that arrive
    // late and change the number of lines.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.sozvonKnock.height(Math.ceil(card.getBoundingClientRect().height));
    }));
  }

  window.sozvonKnock.onShow((knock) => {
    $text.textContent = knock.text || '';

    $actions.textContent = '';
    for (const a of (knock.actions || [])) {
      if (!a || !a.id) continue;
      const b = document.createElement('button');
      b.className = 'action' + (a.primary ? ' primary' : '');
      b.type = 'button';
      b.textContent = a.label || a.id;
      b.addEventListener('click', () => window.sozvonKnock.act(a.id));
      $actions.appendChild(b);
    }
    measure();
  });

  // Closing is not answering: the person is still waiting, and the room's own
  // list still shows them.  It only means "not from here, not now".
  $close.addEventListener('click', () => window.sozvonKnock.dismiss());

  // Escape does the same, for a notification that landed under the cursor
  // mid-sentence.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.sozvonKnock.dismiss();
  });
})();
