# Differences from upstream Galène

Sozvon is a fork of [Galène](https://github.com/jech/galene).
Fork point: upstream commit `ba29f3d`; merged with upstream through
`9e03b36` (Galène 1.1+).

## Added

### SOZVON rebrand & monochrome UI

  * The client is named **SOZVON**. Page titles, the brand lockup, the dynamic
    room-title fallback and the invite share text carry it, and so — since the
    rename that went with going public — do the internal identifiers: the
    `window.Sozvon` global, the `sozvon.*` storage keys, the `/sozvon.apk`
    endpoint, the Go module path `github.com/leyvanah/sozvon`, the Android
    `applicationId` `org.sozvon.app`, the `sozvon` binary and the
    `sozvon.service` unit. The names inherited from upstream —
    `galene.css`, `galene.js`, `/galene-api`, and the `galenectl` tool — are
    deliberately **kept**, both to ease upstream merges and because a fork
    should not paint over what it did not write.

    Renaming those identifiers has migration consequences, and each is
    carried rather than dropped. Stored keys are moved by prefix on load
    (`theme-init.js`, which is blocking in the head of every page, so it runs
    before anything reads one), which keeps remembered logins, the operator's
    session and the theme and language preferences. A server installed under
    the old name is adopted by `contrib/install.sh`: the old unit is stopped
    and removed, `/opt/oryn` is moved to `/opt/sozvon` — one move, so the
    group files that hold the operator's password are never duplicated — and
    the old service account is dropped only after the tree has been chowned
    to the new one. The one thing that cannot be carried is the Android app:
    a changed `applicationId` is a different application to the system, so an
    existing install does not upgrade into it and its saved servers and
    pinned certificates do not come across.
  * **Mark** (`static/sozvon-mark.svg`): a handset standing on end, drawn as
    one unbroken line — identity v1.1, which replaced the linked-O mark of
    v1.0. It is painted as a CSS mask rather than drawn as an `<img>`, so it
    takes `currentColor` and one asset serves both themes. The wordmark stays
    live text at weight 300 (Inter Light), which keeps it selectable and
    localisable.

    The master is a *trace*: the identity has no vector original, so the
    outline was recovered from the raster along the half-intensity iso-line of
    its antialiased edge, and checked back against it by ink coverage rather
    than by counting thresholded pixels (1.5% mean difference). It is filled
    rather than stroked because the line in the master is not of one width.
    Everything else that carries the mark — the favicon, the desktop icon and
    the Android launcher icon — is generated from that one file by
    `contrib/build-mark-assets.py`, which also emits a **heavier cut for small
    sizes**: at 16px the master's hairline works out to a sixth of a pixel and
    the icon comes out an empty rounded square.

    **The mark trails the word.** Leading, it read as an icon announcing a
    name — the shape you scan past on the way to the words; trailing, the name
    is what you meet first and the handset closes it, the way a signature
    works. One lockup in three sizes, and all three follow: join screen,
    settings drawer, landing page. Two things had to change with it. The
    tracking is added *after* the last letter as well as between letters, so a
    trailing mark stood a whole step further off than the gap said — the
    tracking is a custom property now and a negative margin takes exactly it
    back, which also un-skewed the centred landing lockup. And the gap has a
    job it did not have on the other side: it must be clearly wider than the
    tracking, about twice, or the handset joins the word as a seventh letter.
    All three marks are also sized by height alone now, keeping the artwork's
    own 218:590 — the square boxes two of them sat in letterboxed a tall glyph,
    and on this side that padding fell between the word and the mark.
  * **Monochrome design system** in `common.css`: black, a grey ramp, and
    exactly three status colours reserved for state — never decoration.
    “Accent” is not a hue: an emphasised control *inverts* (fill `--accent`,
    text `--accent-contrast`), and because white cannot brighten, hover *dims*
    via `--accent-hover`. Depth on true black comes from `--border` hairlines
    rather than progressively lighter fills — but only where a line is
    carrying structure: the call screen's panels earn their edges from fills
    and `--panel-edge` instead (see *People & chat*).
  * Shape, type, motion and elevation are scales too: `--radius-*` (four
    steps), `--fs-*` (seven), `--t-*`/`--ease`, and `--shadow-1..3`,
    replacing twelve ad-hoc radii, twenty ad-hoc font sizes and seven ad-hoc
    shadows.
  * **Light theme**, chosen from *Appearance* in the settings drawer and in
    the landing page's corner: Auto (follows the operating system, and is the
    default), Light or Dark. An explicit choice persists under `sozvon-theme`
    and outranks the system from then on. `theme-init.js` resolves the three
    to one `data-theme` attribute on `<html>`, blocking in the head so the
    decision is made before the first paint; the light scale is a single
    `:root[data-theme="light"]` block in `common.css`.
    It is **not an inversion**: `#BDBDBD` reads 11.2:1 on black but 1.9:1 on
    white, so the two brand greys swap jobs, tertiary text takes a third
    value, and the status colours darken to ≈5:1 while keeping their hue.
    Values that are *differences* rather than colours each get their own
    token, because they cannot simply be listed twice: the card's top
    highlight, the placeholder tile's label shadow, and the first screen's
    film grain. Chrome printed over video (`--on-video`,
    `--on-video-scrim`) deliberately never flips — the surface underneath is
    someone's camera, not ours.
  * **Settings drawer** shows only camera, microphone, speaker and orientation;
    everything else folds into a native `<details>` — including the host's
    room controls (lock 1-on-1, knock sound), which are the first group inside
    it: they belong to the room rather than to this device, and an operator
    should not have to walk past eleven device knobs to reach them. The
    disclosure itself sits at the very foot, under appearance and language:
    what you opened the drawer for is above it, and this is what you go
    looking for.
  * **Fields are filled, not outlined** — every `.form-control` and `.select`,
    the drawer's on/off switches, the invite dialog's inputs. A column of five
    outlined selects reads as five boxes with labels between them rather than
    as a list of settings; a fill one step off the card (`--surface-3`, the
    step the chat composer already used) says "field" without drawing a frame.
    The border stays declared and transparent, so focus can colour it in
    without the control resizing, and focus is now the only state that draws
    an edge. Two doubled hairlines went with it: the drawer header's rule was
    landing on top of the content's, and the app section drew a divider its
    own legend was already drawing 8px away.
  * **Two shapes, one rhythm, one step larger.** The drawer sorts its rows
    into the only two kinds it has: a setting that holds a *value* — device,
    theme, language — is a quiet label with the control under it, spanning the
    column; a setting you *act on* — a switch, the rotate arrows — is a label
    on the left with its control on the right. Appearance and language used to
    be the second shape while being the first kind of thing, which is most of
    what looked disorderly. Every row now shares one left edge and one right
    edge. The spacing comes from
    two custom properties on the drawer (`--row-gap`, `--group-gap`) rather
    than from a number picked per rule, which is what had left the column
    uneven. And the type goes up a step for reading rather than scanning:
    controls at the interface's body size, labels one below it, group headers
    one below that. The segmented controls take equal thirds instead of thirds
    sized by their words (“Светлое” is wider than “Авто”) — in the drawer only:
    the same pill shares a line with the brand on the join card, where being
    stretched to the card's width shoved it across the logo. And the drawer is
    **320px, the width of the people + chat panel**, so the call sits between
    two columns of one width rather than two of nearly one.
  * **And then the drawer's remaining lines, all of them** — above every
    group header, above the appearance/language pair, above the disclosure,
    under the brand at the top. A panel of a dozen settings had a rule every
    few rows, each one saying what the space around a caps micro-header says
    on its own. Nothing moved closer together to pay for them: rows inside a
    group sit 12px apart where they sat 4, a group header claims 28px above
    itself where it claimed 16, and the gap between two groups is twice the
    gap inside one — which is the whole of what a divider was doing.
  * **Toasts** lost their frame with the fields, and then the colour with it:
    a coloured bar down the side of a grey slab was the only hue on the call
    screen, spent on separating messages that their own first three words
    separate. They are a surface, a shadow and a sentence.
  * **The 404 page had never been through any of this**, and its way back was
    invisible. The base rule set the button's fill and its text together; the
    Sozvon rule below it changed only the fill, to `--accent`. That was right
    while `--accent` was a violet gradient and wrong the moment the palette
    went monochrome — `--accent` became `#FFF`, the text stayed `--text`, which
    is also `#FFF`, and the label disappeared. Black on black in the light
    theme. It takes `--accent-contrast` now, which is what that token is for.
    Worth noting *why* the monochrome commit's own white-on-white audit missed
    it: that check read text-on-fill pairs **within a rule**, and here the fill
    and the text live in two, so the pair never formed. The rest of the page
    followed the others — no card, no `transform: scale(0.8)` shrinking the
    whole layout by a fifth, no paragraph pinned to 35% of the width, and no
    Font Awesome at all (three stylesheets and a webfont were being loaded for
    a single frown, which was also the only solid blob in an interface drawn
    from hairlines). What is left is the wordmark, the status code as a quiet
    stamp, one sentence and one way out.
  * **The join screen lost its card, by the same argument.** A panel earns an
    edge when it has to be told apart from something behind it, and this one
    sits alone on an empty page: the fill, the hairline and the drop shadow
    were drawing a box around the only thing on screen, which made the form
    read as a dialog dropped onto the page rather than as the page. Nothing
    replaces it — with the box gone the form has to hold itself, so it goes up
    a step and the space around it does the framing. The wordmark is a
    masthead rather than a card heading; the two fields put their label above
    a field big enough to be the thing you look at, instead of beside it in a
    3em column; the device-check toggles grow; and Connect spans the column as
    the one action on the screen. (The lockup itself changed at the same time,
    for all three screens that carry it — see *Mark*, above.)
  * **The stage column had no width below 1025px.** `flex: none` sized it by
    its content, and its content — the video grid — is absolutely positioned,
    so it measured zero. Everything drawn against the column collapsed with
    it: the empty-stage placeholder is `inset: 0` on that box, so its tiles
    came out four pixels square and a call where nobody had a camera showed
    nothing. The grid itself is positioned against the viewport, which is why
    one full-stage tile could survive while its neighbours vanished — the
    shape the bug took on screen.
  * **Tiles keep a usable size at any window size.** Both grids (the real one
    and the placeholder's) chose a square-ish number of columns from the
    participant count alone, so two people on a phone held upright were two
    195px chips side by side in an empty screen. The column count is now also
    bounded by what the width can carry — stacking them at 400px each instead
    — and the placeholder, which cannot scroll, caps its tiles to the height a
    row actually has, keeping their 16:9 shape rather than squashing them.
  * **Empty stage**: when the stage has no picture on it, it draws a tile per
    participant **who is not already on the screen** — same grid, surface and
    bottom label as a real video tile, with camera/microphone state inside it
    — instead of leaving an unexplained black rectangle. It says who is *not*
    showing a picture, which is why the exclusion matters: behind the
    self-thumbnail you would otherwise see your own face in the corner and a
    placeholder tile with your own name beside it. Governed by “display
    audio-only users”, the same setting that governs the real tiles.
  * Upstream attribution to Galène / Juliusz Chroboczek is kept in the footer.

### Video layout

  * **Grid / speaker view toggle**, with cleaner per-tile controls. The toggle
    now uses a **picture-in-picture glyph** for speaker view (a framed
    rectangle with an inset corner rectangle), instead of the old person icon
    that duplicated the participants toggle.
  * **Zoom-style speaker view** for 1-on-1 calls: the remote party fills the
    stage, self-view stays as a small tile.
  * **Draggable self-view**: in speaker view the self-thumbnail can be picked
    up and moved anywhere over the stage; it is kept on-screen on resize.
    Switching back to grid view re-flows every tile into the even grid, so a
    moved thumbnail no longer keeps its dragged position and skews the layout.
    Dragging is offered in **every view where the tile floats**, not only the
    1-on-1 one: the drag handler and the clamp-on-resize both used to test for
    the 1-on-1 speaker class alone, so in the multi-remote overlay the tile
    showed a `grab` cursor and could not be moved — and the relayout there
    snapped it back to its home corner rather than clamping it.
  * **Audio-only participants** are shown as tiles rather than hidden, so you
    can see who is connected without a camera.
  * **A muted microphone is visible to the room.** Muting only disables the
    local track — the stream stays published, which is what lets the
    microphone come back without renegotiating — so from every other screen
    nothing happened at all: their copy of your streams still said “audio”,
    and that is what the microphone indicator is derived from. A muted
    participant showed as unmuted everywhere but on their own screen. The
    state is now published as `data.muted` over the same per-user data channel
    the raised hand uses (no server change: a client may already `setdata` on
    itself), re-published on join because that data does not survive one, and
    read back as a `.user-muted` class on the participant's row.
  * **A tile with no picture says whose it is.** Publishing a microphone earns
    you a tile, but the tile is built for a picture: its label carries the
    protocol username, which is empty for anyone who joined without a name,
    and nothing on it says whether the microphone that earned it is even live.
    An empty box in the middle of the stage was the result. Such tiles now
    carry the same label as the placeholder cells — the display name from the
    people list, and glyphs for what is not being published.
  * **Participants publishing nothing get a tile too.** The grid is built from
    streams, so somebody with neither a camera nor a microphone on had no cell
    in it at all: with your own camera on, the stage was your face at full
    size and no sign that anyone else was in the room. They now take a cell
    that looks like a tile with the picture missing — the same one the empty
    stage draws, in the grid rather than over it — under the same “display
    audio-only users” setting, which is the one that decides whether people
    who are not sending a picture appear on the stage at all. The two
    mechanisms stay disjoint: with *no* picture anywhere the empty stage
    covers everything and draws the people itself, so no cells are built
    underneath it. Not drawn in the 1-on-1 speaker view, where the remote's
    picture is positioned over the whole stage — speaker views are about
    pictures, and the participant list is what lists the room.
  * **The same choice while you are alone.** The toggle used to appear only
    once a second person was publishing, so the layout of the room you had
    just opened could not be arranged until somebody arrived. With your camera
    on and nobody else publishing, it now switches between your picture
    filling the stage and your picture stepping into the corner as the
    thumbnail — leaving the stage to say who is in the room: **“You are the
    only one here”**, or a tile per person if others are present with their
    cameras off. That note replaces the placeholder tiles whenever you are the
    room's only participant; a tile carrying your own name told you nothing.
    (The empty stage is computed from what is *behind* the thumbnail, not from
    whether any camera is live: in a speaker view your own picture has left
    the stage for the corner. A tile that is not being rendered does not count
    either, so hiding your own view with the eye brings the placeholder up
    instead of leaving a black field.) Wherever the stage is idle *and* the
    thumbnail floats over it — including a 1-on-1 whose other side has no
    camera — the call area is lifted over the placeholder and hidden by
    visibility, with the thumbnail alone turning it back on: it has a picture,
    and it is the one thing there the pointer still has to reach. The lift is
    on `#video-container` rather than on the grid inside it, and that is a
    cross-engine trap worth remembering: below 1025px the container is
    `position: fixed`, and **Firefox establishes a stacking context for a
    fixed element where Chromium does not**, so a `z-index` on the grid was
    sealed inside it and the placeholder — a sibling of the container — was
    painted over the thumbnail. Firefox only, narrow windows only, and only
    with somebody else in the call whose camera was off.
  * The **“show self-view” pill** is offset by the open settings drawer. It is
    fixed to the viewport, so when the drawer pushed the call area aside the
    pill stayed against the window edge — underneath the drawer, which left
    the only control that brings the self-view back unreachable until the
    drawer was closed.

### People & chat

  * **Unified people + chat panel** — a single resizable split replaces the
    separate lists, with **unread** and **knock** (waiting-room) indicators.
    It **stays where you left it across a change of layout**: the `active`
    class means “collapsed” on the desktop layout and “open” on the mobile
    overlay, one class with opposite meanings, so crossing the 1024px
    breakpoint silently reversed it — a panel the user had closed sprang open
    by itself the moment the window was narrowed, and closed itself again on
    the way back. The panel is toggled at the crossing, which restates the
    same visible state in the new layout's vocabulary.
  * The **panel toggle** is redrawn — the chat bubble is tucked into the
    bottom-right corner of the person icon (with a halo so the two glyphs read
    as person + chat), and the unread/knock dot moved to the top-right, clear
    of it. On desktop the button is **pinned**: opening the panel no longer
    shoves it sideways, so it closes from the same spot, like the settings
    button. The **room title** moved out of the top bar into the panel header so
    the pinned button can't overlap it. The **E2EE lock + emoji SAS** stays in
    the top bar, offset just clear of the toggle (and sliding with the panel as
    it opens), so it is always visible with room for the emoji.
  * **No lines where spacing will do.** The panel used to be drawn with rules:
    one down its full height, one under the room title, one under every
    participant, one over the composer, and a box around the send button. On a
    screen whose content is a handful of faces, a full-height hairline is the
    longest mark there is. They are gone — the column is set off by its fill
    plus `--panel-edge` (a soft shadow in the light theme, nothing in the dark
    one, where the `--surface` step over true black already does it), the rows
    by their avatars and their spacing, the composer by its filled field. The
    split between the list and the chat keeps its drag handle, but the handle
    only draws itself under the pointer, when the resize cursor appears.
    **The settings drawer is the same object and now takes the same edge.** It
    had kept `--shadow-2`, a drop shadow offset *downwards*: on something as
    tall as the window that falls off the bottom of the screen and spreads
    sideways instead, darkening the stage along the drawer's edge — so beside a
    panel casting nothing (dark) or a thin directional edge (light), the drawer
    read as sitting on slightly different ground, though both fills are the
    same `--surface`. `--panel-edge` gained a mirrored twin and each column now
    casts away from itself, into the stage. `--shadow-2` returns below 1025px,
    where the drawer stops pushing the call aside and covers it: there it
    genuinely floats, and a floating thing casts a floating thing's shadow.
    **Mic and camera state left the list** at the same time: it is printed on
    the person's tile, beside their face, and a second copy at the end of
    every row put an icon on every line to say what the tile already said. The
    raised hand stays — it is a request, not a state. The **room title** drops
    to medium weight: at 700 the one word everybody in the room already knows
    was the boldest text on the screen.
  * **Ephemeral 1-on-1 chat**: when the other party leaves a two-person call
    the chat is wiped. An operator also clears the **server-side history**, so
    a private conversation is not replayed to whoever joins next; a non-operator
    clears their own view. Larger meetings (more than two participants) are left
    untouched.

### Controls & media

  * **The dock is glass.** The floating pill was outlined *and* lifted by a
    shadow; the shadow is what makes it read as floating, so the outline went
    and the veil thinned to `--dock-bg` (a light film in either theme — the
    light one cannot use a black veil, because the dock also floats over
    other people's video and its dark glyphs have to survive a dark frame).
    The blur behind it goes up to compensate. The buttons inside were
    flattened earlier for the same reason; the leave button's red ring is now
    the only ring in the dock, which is what a warning should be — and the
    hairline that used to stand before it is replaced by 6px of extra gap,
    which says "and then, separately, this one" without drawing anything.
  * **Independent camera and microphone** buttons — toggling one no longer
    affects the other.
  * **State-reflecting mic/camera icons**: each colours by what is live right
    now — **blue + upright** when the device is on, **red + slashed** when off.
    The old neutral-grey in-between state is gone.
  * **Camera control** as a camera-icon toggle (`fa-video-slash` / `fa-video`),
    consistent with the mic and share icons. Still `<button>` elements, so the
    underlying present/unpresent logic is unchanged.
  * The in-call **Sozvon brand** moved out of the people-panel header into the
    settings drawer, freeing the panel top for the participant list.
  * **Clean login / waiting-room screen**: a `pre-join` body class (from
    `reflectPreJoin()`) hides the top bar, participant sidebar and chat on the
    authentication and waiting-room screens; they return once joined.
  * **Media defaults**: high-quality audio and unlimited send bitrate by default.
  * **Auto-hiding call chrome**: the top bar and bottom control dock slide away
    after 3 seconds of inactivity so the video fills the screen, and return on
    any pointer move, tap, key press or scroll. Paused wherever it would get in
    the way — the login/waiting-room screen, an open people+chat panel, or a
    focused input field.

### Localisation

  * **Russian / English** via a small framework-free engine (`static/i18n.js`):
    markup tagged with `data-i18n*` is translated, and `Sozvon.i18n.t(key, params)`
    covers dynamic strings. Language is auto-detected, remembered in
    `localStorage`, and switchable via EN/RU toggles on the login card, settings
    drawer and landing page. Operator pages (stats, change-password) and
    server-originated messages are still English.
  * **The 404 page is translated too**, and carries no toggle of its own — the
    remembered preference and the browser's language are enough for a page you
    arrive at by accident. `data-i18n` on `<title>` works as it does anywhere
    else, so the tab reads in the visitor's language as well.

### Deployment theming hook

  * A deployment can reskin its instance **without patching the tree**: the
    visitor-facing pages (landing, login / waiting room, 404) load
    `static/theme/theme.css` last (so its rules win the cascade) and
    `static/theme/theme.js` right after `i18n.js`. In the stock distribution
    both are documented no-op stubs, so Sozvon looks and reads the same as
    always; a deployment replaces the contents of `static/theme/` at deploy
    time.
  * `Sozvon.i18n.override(tables)` merges per-language string overrides over
    the built-in translations and re-translates the page, letting a theme
    reword any `data-i18n` key (including dynamic strings that go through
    `Sozvon.i18n.t()`); branding swaps (logo, wordmark, title) are plain DOM
    work from `theme.js`.
  * Theme assets (fonts, textures, SVG) live in the same directory and are
    referenced by relative URL — the same-origin CSP applies to them as to
    everything else. Site-specific themes are intentionally **not** part of
    this repository, in line with keeping deployment-specific setup out of
    the tree.

### Lobby / waiting room

  * Guests join a group via a normal link, enter only a display name, and are
    placed in a waiting room instead of joining directly.
  * The operator sees each pending request and admits or denies it.
  * A `lobby` group is **always** gated while an operator is present: guests
    wait regardless of the group's lock state, so the room behaves as a private
    room across server restarts without relying on `autolock`. (If no operator
    is online yet, the guest is asked to come back.)
  * Invite tokens bypass the lobby (the token itself is the pass).

### Operator room

  * A group marked `"operator-room": true` becomes an **operator hub**. When an
    operator logs in they land on a **dashboard** instead of the call UI (and no
    camera/microphone is requested). The hub is also served at the **site root**
    `/` (the landing page is skipped when a hub exists), so the operator just
    opens the site and logs in; a guest has no hub credentials and cannot get in
    there, and reaches a call only through a personal token link.
  * From the dashboard the operator **creates a personal invite link per
    client** — each link is a stateful token scoped to its own child room
    `hub/<slug>`, with an optional forced client name and a chosen validity
    (**perpetual by default**, or 1/7/30/90 days). A perpetual link carries no
    expiry; unlike upstream — which required every stateful token to expire and
    treated a missing expiry as *invalid* — a nil expiry now means *never
    expires* (the token-list sort and the expired-token cleanup already treated
    it that way). The label may also be left blank: a random slug is generated.
    The link uses a **short root form** `/<slug>/?token=…`
    (the server maps it back to `hub/<slug>`), so the guest never sees the
    `/group/<hub>/` prefix; the long form keeps working. A real static file or
    directory of the same name still takes precedence. Links can be copied, extended and **deleted** (a real
    delete, over the operator's own WebSocket — upstream only offered expiry).
  * Each link shows a live **status** — *idle* / *knocking* / *in call* (with
    who is connected) — refreshed by polling, with the knock sound and a toast
    when a client newly knocks. **Join** opens the client's room; **the red
    hang-up button there returns the operator to the dashboard.**
  * **Knock-and-approve for links.** Unlike an ordinary invite token (which
    bypasses the lobby), a client opening a personal link still **knocks** and
    waits until the operator admits them — *even when no operator is in that room
    yet* (the room is held open, not refused). The token only decides *who may
    knock*; a room with no token cannot be knocked on at all (closing any
    inherited `wildcard-user`).
  * Child rooms are ordinary auto-subgroups of the hub, forced into the lobby at
    runtime (the hub's own config is never rewritten). They inherit the hub's
    codecs, keys and `e2ee`, so a per-client call can be end-to-end encrypted.
  * The operator navigates hub → room → hub without re-entering a password via a
    short-lived (12 h) hierarchical **session token** kept per browser tab.
  * **A link says that it is one.** The dashboard used to decide what to list by
    the only thing it could see — the token's group: anything belonging to a
    child room was drawn as a client's link. But a child room's group also
    collects tokens minted *inside* it: a "remember me on this device" the
    operator ticked while logging in there, an `/invite` from the room's menu.
    Those appeared as extra cards on the same room, so one client showed up as
    three links — and the remembered one, minted with the operator's own
    permissions, was a card you could copy and send, handing a client the room
    as an operator. The mint now records what it made: the server sets `link`
    on a token exactly when a hub mints it for one of its child rooms, which is
    the only shape a client link has, and never reads the field from the client
    request, so a token cannot claim to be one. The dashboard lists tokens
    carrying it; for tokens minted before the flag existed it falls back to the
    old guess minus what a client link can never be — an invite that grants
    `op`. "Remember me" is not offered in a child room at all (it belongs to
    the hub, which is where the operator logs in), and re-logging in now
    **revokes the token it replaces** rather than leaving another live one
    behind — as does logging out, which used to forget the device locally while
    the token stayed valid for its full 30 days.
  * **The dashboard is headed "Operator panel"**, not the hub's `displayName`.
    It had been showing the room's name ("Reception"), which named the thing
    the operator was standing in rather than the page they were looking at, and
    told them nothing they did not know. The hub name keeps the one place it
    still earns: the browser tab, which is where you tell two of them apart on
    a server carrying more than one operator group (only the first is served at
    `/`). Note the same `displayName` is inherited by every child room, so a
    client opening their personal link sees the hub's name as their room's —
    deliberate as far as the client is concerned (it says whose practice they
    have reached), and worth knowing about when naming a hub.
  * **Nine frames became one.** The dashboard had a card drawn round the page,
    a rule under each of two sections, a box round every link, a pill round
    every status, an outline round the URL and one round each of four buttons —
    most of them boundaries the content already had. The card went for the same
    reason the join screen's did: nothing sits behind it. The rules went the way
    the drawer's did, replaced by the same caps micro-header and the space
    around it; the list gained one of its own, so the page reads as three named
    sections rather than two lines and a remainder. The one frame kept is the
    one doing work — a link is a discrete object in a list, so it keeps a fill,
    and only a fill. **Status wears a shape only when the status is news**:
    *idle* is what a room almost always is, and a pill round it put a frame on
    every row to report the absence of anything; *knocking* and *in call* keep
    the pill and the colour. Copy and Delete lost their outlines and let hover
    do the work, leaving one drawn button per row — the one you came for. Name
    and expiry now share the first line, so a link costs three lines instead of
    four. And the join screen's glow stopped leaking: it hung off
    `body.pre-join .btn-blue`, which the dashboard also sets, so every Join in
    the list and the Create above it wore a halo that is supposed to mean *the
    one thing to do here*.
  * **A server installed by `contrib/install.sh` gets a hub by default**, so the
    person who deployed it lands where rooms and links are made rather than in a
    call of their own. The group the installer creates carries
    `"operator-room": true` and neither a `wildcard-user` nor a public listing:
    the only way in for anyone else is a link the operator hands them.
    `--operator-room no` restores the previous shape, an ordinary room behind a
    waiting room that anyone knowing its address may knock on. On an upgrade the
    existing group file is read back rather than overwritten, so what the
    installer reports matches the group that is actually there. The result it
    writes for a client to read gains `"hub": true|false`, and its `url` is the
    site root when there is a hub; the clients open that address after a deploy
    (the Android app already opened the origin; the Electron launcher now takes
    an empty room as "open the server itself").

  Sample hub configuration (`groups/<hub>.json`):

  ```json
  {
    "displayName": "Reception",
    "operator-room": true,
    "users": { "operator": { "password": "…", "permissions": "op" } }
  }
  ```

  (No `wildcard-user`, no `public`. Child rooms `<hub>/<slug>` are created on
  demand as clients knock, and disappear once empty.)

### End-to-end encryption (per group)

  * Opt-in per group via `"e2ee": true` in the group config. When set, the web
    client encrypts media **in the browser** with a key the server never sees,
    so the SFU only ever forwards ciphertext.
  * Two participants run an ephemeral **ECDH** key agreement over the signalling
    channel, authenticated **ZRTP-style** by a 5-emoji Short Authentication
    String the two humans compare aloud; a man-in-the-middle (including a
    malicious server) yields a different SAS on each leg. The responder commits
    to its key first, so the SAS cannot be ground to match.
  * Per-sender **AES-256-GCM** on each encoded frame via `RTCRtpScriptTransform`
    (`static/e2ee-crypto.js`, `e2ee-worker.js`, `e2ee.js`). The SFU stays
    untouched: the frame keeps a cleartext codec prefix (VP8 keyframe = 10 bytes,
    delta = 1; Opus = 0) so `codecs.go` still parses keyframes; the prefix is
    authenticated as GCM additional data and a per-transform IV salt prevents
    nonce reuse across stream replacements.
  * Server side mirrors the `lobby` plumbing: an `E2EE` field on the group
    description and on `Status` (`group/description.go`, `group/group.go`)
    advertises the mode to clients.
  * Scope: exactly two participants, VP8 video + Opus audio (forces VP8 and
    disables simulcast while on). `static/e2ee-test.html` exercises the
    handshake and emoji SAS standalone.
  * **Honest security indicator, never fail-open.** The controller now runs in
    every browser (even those without `RTCRtpScriptTransform`) so it can report
    the real state: a green closed lock + emoji only when both peers are
    actually encrypting; otherwise a red open lock. A browser that cannot
    encrypt announces this to its peer (`{t:'nocrypto'}`) instead of silently
    publishing cleartext while the peer shows "secure". Three-or-more-party and
    unsupported-peer calls fall back to an explicit *“not encrypted”* state.
  * **Require-encryption option** (`"require-e2ee": true`, only with `e2ee`).
    The server limits such a group to **two participants** (turning away anyone
    who would be the third, `group/group.go`), and clients that cannot encrypt
    **refuse to publish** media and show a full-screen *“unencrypted connections
    are blocked”* notice — so the call can never silently downgrade to
    cleartext. Advertised as `requireE2ee` on `Status`.
  * **Encrypted text chat** in two-party E2EE calls: the message rides the
    (un-stored) user-message channel as AES-256-GCM ciphertext under a chat key
    derived from the same ECDH transcript (`deriveChatKey` in
    `static/e2ee-crypto.js`), so the SFU never sees the text nor keeps it in
    history. Larger or unencrypted calls keep normal cleartext chat.
  * A `cleartextMode` toggle in the media worker forwards frames unchanged for
    the allowed-but-unencrypted fallback, while the handshake window still drops
    unkeyed frames so secure media is never emitted in clear.

### Pre-join device check

  * The login card's old *"Nothing / Microphone / Camera and microphone"*
    radio buttons are replaced with two **icon toggles** (camera and
    microphone), both **off by default**.
  * Turning the camera on shows a **live preview**; turning the microphone on
    shows a **level meter** (accent-gradient bars on a canvas), so both can be
    tested before joining. A **device picker** appears under the preview for
    each toggle.
  * The chosen devices are written to the regular media settings — the
    settings drawer's pickers are refreshed with the real device labels as
    soon as a permission grant reveals them — and the preview streams are
    stopped on join so the devices are free for the call.
  * Camera-without-microphone joins are now possible (upstream only offered
    nothing / mic / mic+camera).
  * **The rotate arrows are on the preview**, the same pair the settings
    drawer has and the same quarter turn (`rotateVideo`), in the corner of the
    picture they turn. A sideways camera is noticed exactly once — while
    looking at yourself before joining — and until now the only cure was
    behind a drawer you cannot open until you have joined. The turn is written
    to the same setting the call reads, so it carries in.
  * The preview is a **fixed 4:3 stage** (the ratio the camera is asked for)
    with the picture *contained* rather than cropped: a check whose job is to
    show what your camera is actually sending should not hide a third of it,
    and a quarter turn has to be readable as a turn. A turn swaps the
    picture's own box inside a stage that stays put, so the card does not jump
    between portrait and landscape while you press an arrow. The preview
    applies only the manual base angle, not the auto-rotation — that one
    follows the device's live orientation, which a login form has nothing to
    say about.
  * The same arrows are on the **operator dashboard's** device check, which is
    the same widget under a second id prefix.

### Sign-in, settings & video polish

  * **“Remember me on this device”** (operators only): on login the client
    mints a **revocable, 30-day stateful token** carrying the operator’s own
    username and permissions (via `maketoken`), and stores the *token* — not
    the password — in `localStorage`. On return it auto-probes and a single
    click signs back in as the same operator, no password; expired or revoked
    tokens fall back to the login form. A small server change
    (`rtpconn/webclient.go`) lets a user mint a token for their **own**
    authenticated username (claiming someone else’s defined username is still
    refused). Ordinary guests are never remembered.
  * **Auto-login can’t strand you**: a remember-token carries — and the server
    enforces — its own username, so the auto-login card keeps the **“Log in as
    operator”** link reachable, and editing the name (or choosing operator
    login) drops the token so the typed name/password are honoured instead of
    silently rejoining as the remembered operator. “Remember me” shows only
    while no working token is present.
  * **Settings drawer decluttered**: the “Settings” heading is replaced by the
    Sozvon lockup; the “Media Options” / “Other Settings” frames are dropped;
    the filter control became **“Video orientation”** with localised options,
    and is now **“Rotate video”: two round arrows, a quarter turn each**, sat
    directly under the camera it turns, since turning a picture is something
    you do while looking at it rather than a number you pick from a list of
    four (the stored setting is still the absolute angle the orientation
    canvas applies). **Which way each arrow turns follows the mirror**: your
    own tile is mirrored unless you turn that off, and a mirror reverses the
    direction a rotation appears to go, so the same change of angle reads
    anticlockwise on your screen and clockwise on everybody else's. The arrow
    promises what *you* see while you press it, which is the only feedback you
    have; “Send” → “Outgoing video quality”, “Receive” → “Media reception”,
    “Activity detection” → “Highlight speaker”; blackboard mode moved to the
    bottom.
  * **Top bar**: the E2EE lock sits closer to the panel toggle, and the empty
    grey pill behind a lone red lock is gone (shown only with the emoji SAS).
  * **Links take the palette's emphasis colour**, with their underline doing
    the work of saying they are links. Most already did; the two on the join
    card — “log in as operator” and “log in with different credentials” —
    carried no rule at all and so were drawn in the browser's default blue,
    the one colour the design does not contain. `:visited` is covered too, or
    Firefox keeps a purple of its own for a followed link.
  * Per-tile **bitrate numbers removed**; the toast close “×” made legible —
    and, later, made monochrome. Toastify writes `&#10006;` (U+2716 HEAVY
    MULTIPLICATION X) into the button; no text font in the stack carries that
    codepoint, so it fell through to Segoe UI Emoji and was painted as a
    colour bitmap — a purple ✖ that `color` cannot touch, because a colour
    font paints its own. The library's glyph is blanked and U+00D7 drawn in
    its place: every text font has it, no platform has an emoji for it.
  * **Mobile video controls** overlay translucently and reveal on tap (auto-
    hiding) instead of cropping the picture with a reserved bottom strip. On the
    mobile layout the floating chat button is hidden while the people+chat panel
    overlays the video, so it no longer peeks out beside the open panel.

### Android app & APK self-distribution

  * `android/` holds a minimal **Android app** (Kotlin): a WebView shell
    around the web client plus the plumbing a browser would provide —
    camera/microphone permission handling for getUserMedia, the screen kept
    awake during calls, file downloads, a dark Sozvon theme and icon. The
    server address is asked once and remembered; a **"Change server"**
    launcher shortcut brings the address screen back. Rotation does not
    reload the page (an ongoing call survives it).
  * A GitHub Actions workflow (`.github/workflows/android-apk.yml`) builds
    the APK; no app store involved. See `android/README.md`.
  * The server serves `data/sozvon.apk` at **`/sozvon.apk`** when the file is
    present (`webserver`), and the login card shows a **"Download the
    Android app (APK)"** button only in that case (it probes with a HEAD
    request). The app appends `SozvonApp/<version>` to its user agent, so the
    button is hidden when already inside the app.
  * **In-app fullscreen video**: the video-tile fullscreen control now works in
    the app. A bare WebView ignores the HTML5 fullscreen API, so the app
    implements `WebChromeClient` `onShowCustomView`/`onHideCustomView` (hosts the
    fullscreen view edge-to-edge; the back button leaves fullscreen first). On
    touch the control bar is click-through until tapped, so the first tap reveals
    it instead of being swallowed by an invisible button.
  * **In-app settings** via a `window.SozvonApp` JavaScript bridge (added only to
    the trusted server origin, which is all the WebView ever loads): the web
    client's settings drawer gains an **"App"** section — shown only inside the
    app — with **"Change server"** (reopens the address screen) and **"Reset
    login on this device"** (wipes the saved remember-me token). The address
    screen also gains a **"Reset login data"** action, reachable via the
    "Change server" launcher shortcut.
  * **Deploy a server from the app** (`DeployActivity`, `deploy/SshDeployer.kt`).
    The address screen offers "no server yet?", which asks for a VPS, its SSH
    credentials and a TLS mode, then installs Sozvon on it and comes back with
    the address and the operator password.

    The app does **not** implement the installation: it uploads
    `contrib/install.sh` — the same script a person runs by hand, bundled as
    an asset — starts it detached, and reports what its state file says. The
    install therefore survives the phone sleeping or changing network, which
    over two to five minutes it will: the app polls
    `/var/lib/sozvon-install/state.json` and reconnects rather than holding an
    SSH session open.

    The **host key is confirmed explicitly** — the fingerprint is shown before
    anything is sent, a changed key is a louder prompt showing the old value,
    and accepted keys are remembered per host and port. Accepting silently
    would hand root on the user's server to anyone in the middle. The SSH
    password is never stored; the operator password reaches the installer
    through the environment rather than the command line, since
    `/proc/<pid>/cmdline` is world-readable. SSH is `com.github.mwiede:jsch`,
    the maintained JSch fork (pure Java, no NDK). An **HTTPS port** and a
    **download mirror** can be given for hosts where 443 is taken or GitHub
    is unreachable.

    A server installed with the **self-signed** mode is reachable afterwards
    because the app **pins that exact certificate** (`deploy/CertPins.kt`):
    the installer reports its SHA-256 over the authenticated SSH session, the
    app stores it per host, and `onReceivedSslError` accepts that one
    certificate and refuses everything else — including the same host later
    presenting a different one, which is reported as a changed certificate
    rather than waved through. Accepting anything merely because it is
    self-signed would leave the connection open to whoever can answer for the
    address, which is what TLS is there to prevent.

  * **Managing the server it installed.** A saved server's menu also reaches
    the machine, not just this app's memory of it: *reinstall* runs the
    installer over it (a new version, or a repair, keeping rooms, invite links
    and the operator password), *clean reinstall* purges and installs as if the
    machine were new, and *delete* takes Sozvon off it — with a checkbox deciding
    whether its rooms and accounts go too. A deletion drops the card as well,
    since it would otherwise point at nothing. SSH credentials are asked for
    each time: the app stores the host key, never the credentials, so there is
    nothing to reuse from the install.

  * **Back leaves the server.** On a server's first page, back used to send
    the app to the background, so once inside there was no way to the server
    list at all except the launcher shortcut or a link buried in the web
    client's settings. It now returns to the list, dropping the page rather
    than hiding it — a WebView left loaded keeps its call, camera and
    microphone with nothing on screen to stop it. During a call the app asks
    first, and keeping the call (the old behaviour) stays the default answer.
    One WebView serves every server, so its history is cleared once a newly
    opened server's page is up: otherwise back walks through the `about:blank`
    left by the previous departure — a white screen — and then back into a
    server the user had already left.

  * **Saved servers** (`ServerStore`): the address screen lists every server
    the app has been to as a card — its name, its address and whether its
    certificate is pinned — with rename and remove behind the card's menu.
    The app used to remember exactly one address, so opening a second server
    cost you the first and the deploy wizard overwrote whatever was there;
    an installed server now joins the list. Stored as JSON in the app's own
    preferences, with the old single `server_url` key still written for the
    most recent entry (and migrated into the list on first read). While there
    was one address, `shouldOverrideUrlLoading` compared a link's host against
    *it*; it now compares against the page doing the navigating, which is the
    server actually on screen.

  * **"Open in the app" deep link**: the app registers an `sozvon://open?u=<https
    url>` scheme. When the server serves an APK, an Android *browser* shows an
    **"Open in the app"** button pointing at an `intent://` URL that launches the
    installed app (opening the linked server) and, when the app is absent, lets
    the browser fall back to the APK download. Desktop browsers keep the plain
    download link.

### Desktop app

  * `desktop/` holds an **Electron client** (no upstream equivalent): a window
    onto the web client, a launcher for picking a server and room, and the
    same **deploy-to-a-VPS wizard** as the Android app. Imported from a
    separate repository as a fresh commit rather than with its history, which
    contained a development hostname.
  * Both clients drive `contrib/install.sh` over SSH instead of
    reimplementing the install, so the installation logic has one
    implementation, is testable without either client, and is the same thing
    a person runs by hand. The installer is **not duplicated** in the desktop
    tree: `desktop/scripts/sync-installer.js` copies it in at package time and
    the copy is git-ignored, so the two cannot drift.
  * **A loaded server is never a dead end.** An application menu carries
    "change server" (`Ctrl+Shift+S`), a login reset and reload (`Ctrl+R`, `F5`
    — the app previously had no reload binding at all); the menu bar is hidden
    on the app's own screens and shown while a server's page is loaded, which
    is when there is nothing else to steer by. The preload also exposes the
    same `window.SozvonApp` bridge as the Android app, so the web client reveals
    its **App** section — "change server", "reset login" — inside the desktop
    client too, with no server-side change. A main-frame load failure returns
    to the launcher with the reason shown instead of leaving the browser's own
    error page in a window with no controls.
  * **Saved servers** (`config.servers`): the launcher lists every server the
    client has been to as a card — name, address, last room, and whether its
    certificate is pinned — with *open*, *rename* and *remove*. Recent rooms
    belong to the server they were opened on rather than to the app. A server
    installed by the deploy wizard is added to the list instead of replacing
    the one already there, and a configuration written by an earlier build is
    migrated into the list on first load.

### Operations / self-hosting

  * **Static files are compressed** (`webserver/compress.go`). Upstream serves
    them uncompressed through its own file handler; the client's first load was
    808 KB, of which ~500 KB was text. A room now loads in 160 KB. Compressing
    inside a handler needs care and the code documents each point: a distinct
    ETag for the gzipped representation (a shared one lets a cache hand a
    gzipped body to a client that cannot decode it), `Vary: Accept-Encoding`,
    no `Content-Length`, `Range` dropped rather than answered wrongly, only
    200s compressed, already-compressed types excluded, and `gzip;q=0` honoured
    as the refusal it is.
  * **The vendored Font Awesome webfonts are subset** to the glyphs the client
    uses: 154 KB → 3 KB, since woff2 is already Brotli-compressed and gzip does
    nothing for it. `contrib/subset-fontawesome.py` regenerates them and must
    be re-run when an icon is added — otherwise the new icon silently renders
    as nothing. See CONTRIBUTING.md.

  * **Built-in Let's Encrypt** via a `-letsencrypt host[,host]` flag: the
    server obtains and renews TLS certificates itself (the standard library's
    `autocert`), with no certbot or reverse proxy. The ACME **TLS-ALPN-01**
    challenge is answered on the main 443 listener; a best-effort plain-HTTP
    server on **:80** adds **HTTP-01** and an http→https redirect (a failure to
    bind :80 — e.g. no `CAP_NET_BIND_SERVICE` — is logged, not fatal, since
    TLS-ALPN-01 still works). Certificates are cached under `data/acme/`. The
    flag is mutually exclusive with `-insecure`; the existing `data/cert.pem` +
    `data/key.pem` path is unchanged when it is absent. (Adds an indirect
    dependency on `golang.org/x/text`, pulled in by `autocert`'s IDNA host
    handling.)
  * **`/healthz`** — an unauthenticated, never-cached **liveness** endpoint
    answering `200 ok` (GET/HEAD) while the HTTP server is up, with no
    dependency on any subsystem. For load balancers, uptime monitors and
    systemd/container health checks.
  * **`--purge`** in the installer: `--uninstall` stops and removes the
    service and deliberately leaves `data/` and `groups/` — rooms, operator
    accounts, invite links, certificates — so installing again picks them up.
    `--purge` deletes those too, along with the service account, and refuses
    to run when `--prefix` names a system directory, since deleting the wrong
    tree recursively as root cannot be walked back. This is what the clients
    drive for "delete the server" and "clean reinstall".
  * A sample **systemd unit** (`contrib/systemd/sozvon.service`) running as a
    dedicated unprivileged user with `CAP_NET_BIND_SERVICE` and the usual
    sandboxing (`ProtectSystem=strict`, `ReadWritePaths` limited to
    `data/`, `groups/`, `recordings/`).

### Security hardening

  * **The generated operator password no longer outlives the install.** The
    installer hands its result back through
    `/var/lib/sozvon-install/result.json`, which carries that password in clear
    (mode 0600, root) because that is the contract both clients read. Its own
    closing message told the reader to delete the file once they had it, and
    nothing ever did — so a password the app's result screen calls *"shown
    only once"* was in fact sitting on the server permanently, for anyone who
    later gained root (or the docker group, which amounts to the same). Both
    clients now delete it as soon as the JSON has parsed — after the parse on
    purpose, since deleting first would destroy the password on a file that
    turned out to be unreadable — and treat a failed delete as non-fatal: the
    server is up and the user has what they came for. The account itself was
    never the problem; it is stored bcrypt-hashed, as `type: bcrypt` in the
    group file.
  * **Escalating delay on failed logins** (`authlimit/`): after each failed
    authentication from an address the response is delayed exponentially —
    200 ms, 400 ms, 800 ms … capped at 15 s — instead of upstream's fixed
    200 ms (or, on some paths, no delay at all). The record is cleared by a
    successful login and forgotten after 10 minutes idle.
  * One shared per-IP failure counter covers **every authentication surface**,
    so a guesser cannot dodge the delay by switching paths: the WebSocket
    group join (the normal user/operator login), the `/recordings/` pages
    (HTTP basic auth, upstream: fixed 200 ms), and the `/galene-api/`
    administrative API (upstream: no delay). A credential-less request — the
    browser's initial basic-auth probe — is not counted as a failure.
  * **Temporary ban after too many failures**: the 10th failed attempt from
    an address blocks it for **15 minutes** — further logins are refused
    before any password is even looked at (the web client shows the reason;
    HTTP surfaces answer `429` with a `Retry-After`). The **last 3 attempts
    before the ban carry an explicit warning** in the login error (*“N
    attempts left before this address is temporarily blocked”*), so a
    legitimate user who is merely mistyping is never banned without notice.
    A successful login clears the count. Note the flip side of any ban:
    everyone behind the same NAT/proxy address shares it.
  * **fail2ban integration**: every failed login is logged with the offending
    address (`Failed login from <ip> (<surface>)`), and
    `contrib/fail2ban/` ships a filter + jail so persistent guessers can
    additionally be banned at the firewall for much longer than the
    built-in 15 minutes.

### Dev / build

  * **`-dev` flag** (`webserver`): disables static-asset cache headers so client
    changes show up on reload during development. Off in production.

## Planned

### Clients, after the first end-to-end deploy from a phone

Found by installing a server from the Android app onto a real machine and
joining the room from it. In rough order of how much they get in the way.

  * **A tile with the camera off should show who it is, not a play button.**
    A `<video>` element carrying no picture falls back to the WebView's own
    play affordance — a large triangle filling the tile, which says nothing
    about who is there. It should be a card with the participant's name and
    the same avatar colour the participant list gives them. Started on
    `feat/videoless-tiles` (`sozvonTileCard()`, keyed off `videoWidth > 0`);
    needs finishing and testing on a device, including the case where a
    camera is turned off mid-call and back on.

  * **Investigate a jump to the browser on first connect.** Reported once,
    on the first connection after a deploy, and not reproduced since — the
    same server then opened inside the app. Worth pinning down before it is
    dismissed: candidates are `shouldOverrideUrlLoading` handing an
    off-origin URL to the browser, and the web client's own "open in the app"
    intent link. Needs a reproduction first.

### The rebrand, finishing it

Left over from the monochrome/SOZVON pass. Roughly in order of value.

  * **The light theme's last gap: the pre-join login card.** The card is the
    only screen a visitor arriving on a room link sees, and it carries no
    appearance control — the drawer is unreachable until you have joined, and
    the landing page is a different page. Left out on purpose: a trio of word
    buttons does not fit beside the brand and the language pair without
    giving the calmest screen in the client a second row of chrome. Wants an
    icon-only control, which in turn wants glyphs the Font Awesome subset
    does not currently carry (see `contrib/subset-fontawesome.py`).
  * **Inter is not self-hosted.** `--font` asks for it and the identity
    specifies it, but no font file ships, so it silently falls back to a
    system face and the identity's typography is not actually in effect.
    Needs a Latin+Cyrillic woff2 subset in `static/` (the CSP is same-origin,
    so Google Fonts is not an option) plus the SIL OFL licence text.
  * **The dead light-theme layer in `galene.css`.** 104 colour literals sit in
    rules that the Sozvon layer later overrides — upstream's light styling,
    inert but still there. Shipping a light theme did not revive it: the
    layer that overrides it reads tokens, and the tokens are what the theme
    switches. Removing it shortens the file and removes a whole
    class of future confusion, but the "overridden later" test used to find
    them does not account for `@media`, so it needs care rather than a script.
  * **A single icon set.** Font Awesome Solid has no consistent stroke weight,
    which is the loudest remaining inconsistency. The blocker is that
    `galene.js` swaps Font Awesome class names in 26 places, so a real
    migration means a `setIcon()` layer and an SVG sprite, all at once — a
    half-migration puts two icon languages on one screen. Weight is no longer
    an argument for it (compression and subsetting settled that); do it only
    when the look starts to matter.
  * ~~**The operator room** needs the same economy pass the call screen got~~ —
    done; see *Operator room* above. It is still worth re-reading for the
    defect class described next.

**One lesson worth carrying forward.** Replacing 342 colour literals with
tokens was mostly mechanical, and every bug it produced had the same shape: a
value that was not a *colour* but a *difference*. A fully transparent border
reserving space for the active-speaker ring became a visible grey frame around
every tile. Two `rgba` black scrims that darken video for legibility became
white washes. Five hover states collapsed onto their own base value when
`--accent-2` — used almost exclusively *as* the hover of `--accent` — was
folded into it, and two more lost their only cue when `filter: brightness()`
ended up over a fill that was now pure white. None of these look wrong in a
diff; they look wrong on screen. When touching the remaining literals, check
pairs (base vs `:hover`, fill vs text on it) rather than single declarations —
comparing a rule against its pre-change self is what actually found them.

### Other

  * **The join screen's film grain has never rendered.** It is a `data:` URI in
    `body.pre-join .login-container::after`, and the server sends
    `img-src 'self'` (`cspHeader` in `webserver/webserver.go`), so the browser
    refuses it — the texture the rule describes has been inert for as long as
    the rule has existed, and the first screen is plain `--bg`. The fix is to
    serve the speckle as a file rather than widen the policy; it matters more
    now that the card is gone and nothing else is drawn on that page.
  * **Group E2EE (3+ participants)**: a sender-key scheme with a single shared
    "group security code", since pairwise SAS does not scale. Until then,
    such calls run in the explicit *“not encrypted”* state (or are blocked when
    `require-e2ee` is set).
  * A pre-flight **unsupported-browser notice** (e.g. Xiaomi Mi Browser, whose
    WebRTC hangs) offering to open in a working browser.
  * **Install errors in the app's language, and actionable.** Asked for
    2026-08-16. The failure screen prints the installer's own line verbatim —
    *"the mirror has no 'latest' file; pass --version explicitly"* — which is
    English, addressed to whoever runs `install.sh` by hand, and names a flag
    the app never shows. The installer already fails with a small, fixed set
    of causes; give each a stable machine-readable code (it writes
    `state.json`, which is the natural place), and let the client map the code
    to a translated sentence saying what went wrong **and what to do about it**
    — the raw line staying available underneath for a bug report. Doing it by
    matching English text in the client would break the moment a message is
    reworded.
  * **Closing the chat and the settings panel on a phone.** Asked for
    2026-08-16. Both open as full-height panels that can only be dismissed
    with their ✕, and while one is open the bottom dock is gone — so leaving
    the chat is a hunt for a small target, and the call's own controls are
    unreachable meanwhile. Wanted: tap outside to dismiss, a swipe (left on
    the chat, right on the drawer), and the dock staying put underneath.
  * **A server-settings place, reachable from a deployed server.** Asked for
    2026-08-16, after deploying from the phone: once the install screen's
    password has been written down there is nowhere to *change* it, and no way
    to change the operator's **login** at all. The operator dashboard is the
    obvious home — it is the first screen an operator sees and it now has room
    — and the two fields belong together, since renaming the account is a
    rewrite of the same group file the password lives in. Note the split: the
    password half is nearly built (see the entry below, and the same
    `writableGroups` gate applies), while renaming a user has **no upstream
    API** — `webserver/api.go` exposes `.users/<user>/.password` but nothing
    that moves a user to a new name, so it needs a create-then-delete over the
    existing endpoints, or a small endpoint of its own. Renaming also
    invalidates any remember-token minted for the old name, which the client
    has to be told about rather than left to fail at the next auto-login.
  * **Self-service password change, surfaced properly.** Upstream Galène
    already has the plumbing: a bare `/change-password.html` page and a
    `.../.users/<user>/.password` API (`webserver/api.go`) that accepts the
    user's own old password (HTTP Basic auth, checked against the stored
    hash) or an admin credential, and always re-hashes the new one with
    bcrypt on save regardless of how the old one was stored. Two things gate
    it today: the server-wide `writableGroups` config flag (off by default —
    without it the API refuses to write the group file at all), and the fact
    that it's just a small "Change password" link next to the username in
    the settings drawer (`#chpwspan` in `galene.html`) that pops the bare
    page open in a new tab. Plan: add a proper **"Security" section** to that
    drawer — old password / new password / confirm, styled like the rest of
    Sozvon, calling the existing API inline instead of linking out — and turn
    `writableGroups` on wherever operators should be able to use it. Doing
    this also happens to fix any operator password still sitting in the
    group file as plaintext, the first time it's changed through the form.
  * **Password recovery** — nothing exists yet, upstream or here; today a
    forgotten password can only be reset by whoever has server/file access
    (`galenectl set-password`, or hand-editing the group JSON). Needs actual
    design, not just UI. Options to weigh, roughly in order of how well they
    fit what's already built:
    1. Reuse the **stateful invite-token** mechanism already built for the
       operator hub (see "Operator room" above): an admin-issued, one-time
       reset link. Fits the existing token infrastructure best.
    2. A single-use **recovery code** shown once at password-set time (like
       2FA backup codes) and stored hashed alongside the password. Fully
       self-service, no new server dependency, but only works if the
       operator saved the code somewhere safe beforehand.
    3. **Admin-mediated, but a button instead of a shell command** — a
       one-click "reset this operator's password" action from the operator
       hub dashboard that generates a new temporary password. Simplest to
       build, but not actually self-service.
    4. **Email-based reset.** Most familiar to users, but by far the most
       infrastructure: needs a new optional recovery-contact field per user
       *and* an SMTP relay configured server-side — another site-specific
       secret that would have to stay out of the repo, the same way TURN
       credentials and hostnames are kept out today.
    No decision made yet — revisit once the change-password UI above lands.
  * Further features, documented here as they land.
