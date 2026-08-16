// Sozvon i18n — lightweight localisation (English + Russian).
//
// Static markup is tagged with data-i18n / data-i18n-title /
// data-i18n-placeholder / data-i18n-value / data-i18n-html attributes and
// translated on load. Dynamic strings call Sozvon.i18n.t(key, params).
// Language is auto-detected from the browser and remembered in localStorage;
// EN/RU toggles are wired via [data-lang-option] and [data-lang-select].
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

(function() {
    'use strict';

    const translations = {
        en: {
            // Login / join
            'login.lobbyNote': 'This is a private room. Enter your name below and the host will let you in.',
            'login.username': 'Username',
            'login.password': 'Password',
            'login.remember': 'Remember me on this device',
            'login.operatorLogin': 'Log in as operator',
            'login.rejoinAs': 'Join as',
            'login.rejoinOther': 'Log in with different credentials',
            'login.checkDevices': 'Check your devices:',
            'login.camera': 'Camera',
            'login.microphone': 'Microphone',
            'login.noCamera': 'Could not access the camera',
            'login.noMic': 'Could not access the microphone',
            'login.micSilent': 'We cannot hear you — please say something. If the bar does not move, pick another microphone below.',
            'login.micDenied': 'Microphone access is blocked. Click the camera or microphone icon in the browser address bar, choose Allow, then try again.',
            'login.micNotFound': 'No microphone was found. Connect one and try again.',
            'login.micUnavailable': 'That microphone is unavailable — pick another one below.',
            'login.micEnded': 'The microphone stopped — access was revoked or the device was disconnected.',
            'login.camDenied': 'Camera access is blocked. Click the camera or microphone icon in the browser address bar, choose Allow, then try again.',
            'login.camNotFound': 'No camera was found. Connect one and try again.',
            'login.camUnavailable': 'That camera is unavailable — pick another one below.',
            'login.connect': 'Connect',
            'login.apk': 'Download the Android app (APK)',
            'login.openInApp': 'Open in the app',
            // Not found (404.html)
            'notfound.title': 'Page not found',
            'notfound.text': "We can't find the page you're looking for.",
            'notfound.home': 'Back to home',
            // Waiting room
            'lobby.title': 'Waiting room',
            'lobby.text': 'The host will let you in shortly…',
            'lobby.waitingFor': 'You are in the waiting room{who}. The host will let you in shortly…',
            'lobby.admitted': 'You have been admitted, connecting…',
            // Operator room (dashboard)
            'operator.title': 'Operator panel',
            'operator.subtitle': 'Create a personal link for each client and let them in when they knock.',
            'operator.logout': 'Log out',
            'operator.devicesTitle': 'Camera & microphone',
            'operator.label': 'Label',
            'operator.labelHint': 'e.g. Ivan Petrov',
            'operator.clientName': 'Client name (optional)',
            'operator.clientNameHint': 'shown to the client, fills their name',
            'operator.expiry': 'Valid for',
            'operator.expiryForever': 'Never expires',
            'operator.expiry1': '1 day',
            'operator.expiry7': '7 days',
            'operator.expiry30': '30 days',
            'operator.expiry90': '90 days',
            'operator.create': 'Create link',
            'operator.createTitle': 'New link',
            'operator.linksTitle': 'Links',
            'operator.options': 'Options',
            'operator.noLinks': 'No links yet. Create one above.',
            'operator.copy': 'Copy',
            'operator.copied': 'Copied',
            'operator.join': 'Join',
            'operator.delete': 'Delete',
            'operator.deleteConfirm': 'Delete the link for {name}?',
            'operator.statusEmpty': 'idle',
            'operator.statusKnocking': 'knocking: {names}',
            'operator.statusInCall': 'in call: {names}',
            'operator.expires': 'expires {date}',
            'operator.expired': 'expired',
            'operator.noExpiry': 'never expires',
            'operator.knockToast': '{who} is knocking — {room}',
            'operator.admitJoin': 'Admit & join',
            // Navigation / controls
            'nav.collapse': 'Collapse left panel',
            'nav.panel': 'People & chat',
            'nav.camera': 'Camera',
            'nav.startVideo': 'Start video',
            'nav.stopVideo': 'Stop video',
            'nav.mute': 'Mute',
            'nav.share': 'Share Screen',
            'nav.view': 'View',
            'nav.gridView': 'Grid view',
            'nav.speakerView': 'Speaker view',
            'nav.leave': 'Leave',
            // Chat
            'chat.hide': 'Hide chat',
            'chat.placeholder': 'Type /help for help',
            // Settings
            'settings.title': 'Settings',
            'settings.changePassword': 'Change password',
            'settings.logout': 'Logout',
            'settings.camera': 'Camera',
            'settings.microphone': 'Microphone',
            'settings.speaker': 'Speaker',
            'settings.mirror': 'Mirror view',
            'settings.blackboard': 'Blackboard mode',
            'settings.noise': 'Noise suppression',
            'settings.hqaudio': 'High-quality audio',
            'settings.rotate': 'Rotate video',
            'settings.rotateLeft': 'Rotate left',
            'settings.rotateRight': 'Rotate right',
            'settings.autorotate': 'Auto-rotate (mobile/tablet)',
            'settings.filter': 'Filter',
            'settings.send': 'Outgoing video quality',
            'settings.simulcast': 'Simulcast',
            'settings.receive': 'Media reception',
            'settings.activity': 'Highlight speaker',
            'settings.displayAll': 'Display audio-only users',
            'settings.multishare': 'Allow multiple screen shares',
            'filter.mirror-h': 'Horizontal flip',
            'filter.mirror-v': 'Vertical flip',
            'filter.rotate': 'Rotate',
            'filter.rotate-90': 'Rotate 90°',
            'filter.rotate-270': 'Rotate 270°',
            'filter.background-blur': 'Background blur',
            'settings.language': 'Language',
            'settings.theme': 'Appearance',
            'theme.system': 'Auto',
            'theme.light': 'Light',
            'theme.dark': 'Dark',
            'settings.advanced': 'Advanced',
            'settings.appSection': 'App',
            'settings.changeServer': 'Change server',
            'settings.resetLogin': 'Reset login on this device',
            'settings.operatorSection': 'Host controls',
            'settings.locked1on1': 'Lock room 1-on-1 (block 3+ participants)',
            'settings.knockSound': 'Play sound on lobby knock',
            // Select options
            'opt.off': 'off',
            'opt.default': 'default',
            'opt.none': 'none',
            'opt.lowest': 'lowest',
            'opt.low': 'low',
            'opt.normal': 'normal',
            'opt.unlimited': 'unlimited',
            'opt.auto': 'auto',
            'opt.on': 'on',
            'opt.nothing': 'nothing',
            'opt.audioOnly': 'audio only',
            'opt.screenshareOnly': 'screenshare only',
            'opt.lowQuality': 'low quality',
            'opt.everything': 'everything',
            // Video tile controls
            'vc.play': 'Play video',
            'vc.volume': 'Volume',
            'vc.pip': 'Picture In Picture',
            'vc.fullscreen': 'Fullscreen',
            'vc.stop': 'Stop video',
            'vc.hide': 'Hide video',
            'vc.show': 'Show video',
            // Invite dialog
            'invite.username': 'Username (optional)',
            'invite.notBefore': 'Not before',
            'invite.expires': 'Expires',
            'invite.invite': 'Invite',
            'common.cancel': 'Cancel',
            'common.close': 'Close',
            // Messages
            'msg.useCamera': 'Use the camera button to enable your camera or microphone.',
            'msg.serverSaid': 'The server said: {message}',
            // Landing page
            'home.group': 'Group',
            'home.join': 'Join',
            'home.publicGroups': 'Public groups',
            // Participant menu
            'menu.raiseHand': 'Raise hand',
            'menu.unraiseHand': 'Unraise hand',
            'menu.inviteUser': 'Invite user',
            'menu.broadcastFile': 'Broadcast file',
            'menu.restartMedia': 'Restart media',
            'menu.sendFile': 'Send file',
            'menu.forbidPresent': 'Forbid presenting',
            'menu.allowPresent': 'Allow presenting',
            'menu.mute': 'Mute',
            'menu.kick': 'Kick out',
            'menu.identify': 'Identify',
            'userlist.mute': 'Mute',
            'userlist.unmute': 'Unmute',
            'userlist.volume': 'Volume',
            // Lobby knock actions (operator)
            'knock.admit': 'Admit',
            'knock.deny': 'Deny',
            // Toasts / notifications
            'toast.askingToJoin': '{who} is asking to join',
            'toast.someone': 'Someone',
            'toast.hostDeclined': 'The host declined your request to join',
            'toast.groupLocked': 'This group is locked',
            'toast.muted': 'You have been muted',
            'toast.mutedBy': 'You have been muted by {who}',
            'toast.noWebrtc': "This browser doesn't support WebRTC",
            'toast.fetchStatus': "Couldn't fetch status: {error}",
            'toast.notConnected': 'Not connected.',
            'toast.cantConnect': "Couldn't connect to {url}",
            'toast.reconnected': 'Reconnected.',
            'toast.reconnectFailed': "Couldn't reconnect — please log in again.",
            'reconnect.reconnecting': 'Reconnecting…',
            'stage.noVideo': 'Nobody has turned their camera on.',
            'stage.onlyYou': 'You are the only one here.',
            'chat.placeholder': 'Message',
            'chat.send': 'Send',
            'toast.rememberOpOnly': 'Only the host can stay signed in on this device.',
            'toast.rememberExpired': 'Saved sign-in expired — please log in again.',
            'toast.noMedia': 'Select a camera or microphone first.',
            'toast.settingNextCall': 'Saved — it will take effect the next time the microphone is turned on.',
            'toast.noDevice': 'No camera or microphone was found.',
            'toast.permissionDenied': 'Camera or microphone access was denied.',
            'toast.micEnded': 'The microphone stopped — access was revoked or the device was disconnected. Turn it on again to reconnect.',
            'toast.enableHint': 'Use the camera or microphone buttons to start.',
            'toast.roomBusy': 'Room is busy, try again later',
            // End-to-end encryption
            'e2ee.secure': 'End-to-end encrypted — compare these emoji with the other person',
            'e2ee.handshaking': 'Establishing end-to-end encryption…',
            'e2ee.failed': 'Encryption check failed — possible interception',
            'e2ee.multipeer': 'End-to-end encryption supports only two participants',
            'e2ee.notEncrypted': 'This call is not encrypted',
            'e2ee.blocked': 'Unencrypted connections are blocked',
            'e2ee.blockedOverlay': 'Unencrypted connections are blocked. This call cannot be end-to-end encrypted (a participant cannot encrypt, or there are more than two), so the connection is blocked.',
            // Browser support
            'browser.unsupported': 'Your browser does not support video calls. Please open this link in Chrome, Firefox, Safari or Edge.',
        },
        ru: {
            'login.lobbyNote': 'Это приватная комната. Введите своё имя ниже — и хост вас впустит.',
            'login.username': 'Имя',
            'login.password': 'Пароль',
            'login.remember': 'Запомнить на этом устройстве',
            'login.operatorLogin': 'Войти как оператор',
            'login.rejoinAs': 'Подключиться как',
            'login.rejoinOther': 'Войти с другими данными',
            'login.checkDevices': 'Проверьте устройства:',
            'login.camera': 'Камера',
            'login.microphone': 'Микрофон',
            'login.noCamera': 'Не удалось получить доступ к камере',
            'login.noMic': 'Не удалось получить доступ к микрофону',
            'login.micSilent': 'Мы вас не слышим — скажите что-нибудь. Если полоска не двигается, выберите другой микрофон ниже.',
            'login.micDenied': 'Доступ к микрофону заблокирован. Нажмите на значок камеры или микрофона в адресной строке браузера, выберите «Разрешить» и попробуйте снова.',
            'login.micNotFound': 'Микрофон не найден. Подключите его и попробуйте снова.',
            'login.micUnavailable': 'Этот микрофон недоступен — выберите другой ниже.',
            'login.micEnded': 'Микрофон отключился — доступ отозван или устройство отсоединено.',
            'login.camDenied': 'Доступ к камере заблокирован. Нажмите на значок камеры или микрофона в адресной строке браузера, выберите «Разрешить» и попробуйте снова.',
            'login.camNotFound': 'Камера не найдена. Подключите её и попробуйте снова.',
            'login.camUnavailable': 'Эта камера недоступна — выберите другую ниже.',
            'login.connect': 'Войти',
            'login.apk': 'Скачать приложение для Android (APK)',
            'login.openInApp': 'Открыть в приложении',
            // Not found (404.html)
            'notfound.title': 'Страница не найдена',
            'notfound.text': 'Мы не нашли страницу, которую вы искали.',
            'notfound.home': 'На главную',
            'lobby.title': 'Комната ожидания',
            'lobby.text': 'Хост скоро вас впустит…',
            'lobby.waitingFor': 'Вы в комнате ожидания{who}. Хост скоро вас впустит…',
            'lobby.admitted': 'Вас впустили, подключаемся…',
            // Operator room (dashboard)
            'operator.title': 'Панель оператора',
            'operator.subtitle': 'Создавайте персональную ссылку для каждого клиента и впускайте, когда он постучится.',
            'operator.logout': 'Выйти',
            'operator.devicesTitle': 'Камера и микрофон',
            'operator.label': 'Название',
            'operator.labelHint': 'напр. Иван Петров',
            'operator.clientName': 'Имя клиента (необязательно)',
            'operator.clientNameHint': 'показывается клиенту, заполняет его имя',
            'operator.expiry': 'Срок действия',
            'operator.expiryForever': 'Бессрочно',
            'operator.expiry1': '1 день',
            'operator.expiry7': '7 дней',
            'operator.expiry30': '30 дней',
            'operator.expiry90': '90 дней',
            'operator.create': 'Создать ссылку',
            'operator.createTitle': 'Новая ссылка',
            'operator.linksTitle': 'Ссылки',
            'operator.options': 'Параметры',
            'operator.noLinks': 'Пока нет ссылок. Создайте выше.',
            'operator.copy': 'Копировать',
            'operator.copied': 'Скопировано',
            'operator.join': 'Войти',
            'operator.delete': 'Удалить',
            'operator.deleteConfirm': 'Удалить ссылку для «{name}»?',
            'operator.statusEmpty': 'пусто',
            'operator.statusKnocking': 'стучится: {names}',
            'operator.statusInCall': 'на звонке: {names}',
            'operator.expires': 'до {date}',
            'operator.expired': 'истекла',
            'operator.noExpiry': 'бессрочная',
            'operator.knockToast': '{who} стучится — {room}',
            'operator.admitJoin': 'Впустить и присоединиться',
            'nav.collapse': 'Свернуть панель',
            'nav.panel': 'Участники и чат',
            'nav.camera': 'Камера',
            'nav.startVideo': 'Включить камеру',
            'nav.stopVideo': 'Выключить камеру',
            'nav.mute': 'Микрофон',
            'nav.share': 'Показать экран',
            'nav.view': 'Вид',
            'nav.gridView': 'Сетка',
            'nav.speakerView': 'Крупный план',
            'nav.leave': 'Выйти',
            'chat.hide': 'Скрыть чат',
            'chat.placeholder': 'Введите /help для справки',
            'settings.title': 'Настройки',
            'settings.changePassword': 'Сменить пароль',
            'settings.logout': 'Выйти',
            'settings.camera': 'Камера',
            'settings.microphone': 'Микрофон',
            'settings.speaker': 'Динамик',
            'settings.mirror': 'Зеркальное отражение',
            'settings.blackboard': 'Режим доски',
            'settings.noise': 'Шумоподавление',
            'settings.hqaudio': 'Аудио высокого качества',
            'settings.rotate': 'Повернуть видео',
            'settings.rotateLeft': 'Повернуть влево',
            'settings.rotateRight': 'Повернуть вправо',
            'settings.autorotate': 'Автоповорот (моб./планшет)',
            'settings.filter': 'Фильтр',
            'settings.send': 'Качество исходящего видео',
            'settings.simulcast': 'Simulcast',
            'settings.receive': 'Приём медиа',
            'settings.activity': 'Подсвечивать говорящего',
            'settings.displayAll': 'Показывать участников без видео',
            'settings.multishare': 'Разрешить несколько демонстраций экрана',
            'filter.mirror-h': 'Горизонтальное отражение',
            'filter.mirror-v': 'Вертикальное отражение',
            'filter.rotate': 'Повернуть',
            'filter.rotate-90': 'Повернуть на 90°',
            'filter.rotate-270': 'Повернуть на 270°',
            'filter.background-blur': 'Размытие фона',
            'settings.language': 'Язык',
            'settings.theme': 'Оформление',
            'theme.system': 'Авто',
            'theme.light': 'Светлое',
            'theme.dark': 'Тёмное',
            'settings.advanced': 'Дополнительно',
            'settings.appSection': 'Приложение',
            'settings.changeServer': 'Сменить сервер',
            'settings.resetLogin': 'Сбросить вход на этом устройстве',
            'settings.operatorSection': 'Управление комнатой',
            'settings.locked1on1': 'Комната 1-на-1 (не пускать третьего)',
            'settings.knockSound': 'Звук при стуке в комнату ожидания',
            'opt.off': 'выкл',
            'opt.default': 'по умолчанию',
            'opt.none': 'нет',
            'opt.lowest': 'минимальное',
            'opt.low': 'низкое',
            'opt.normal': 'обычное',
            'opt.unlimited': 'без ограничений',
            'opt.auto': 'авто',
            'opt.on': 'вкл',
            'opt.nothing': 'ничего',
            'opt.audioOnly': 'только звук',
            'opt.screenshareOnly': 'только демонстрация экрана',
            'opt.lowQuality': 'низкое качество',
            'opt.everything': 'всё',
            'vc.play': 'Воспроизвести',
            'vc.volume': 'Громкость',
            'vc.pip': 'Картинка в картинке',
            'vc.fullscreen': 'Полный экран',
            'vc.stop': 'Остановить видео',
            'vc.hide': 'Скрыть видео',
            'vc.show': 'Показать видео',
            'invite.username': 'Имя (необязательно)',
            'invite.notBefore': 'Не раньше',
            'invite.expires': 'Истекает',
            'invite.invite': 'Пригласить',
            'common.cancel': 'Отмена',
            'common.close': 'Закрыть',
            'msg.useCamera': 'Нажмите кнопку камеры, чтобы включить камеру или микрофон.',
            'msg.serverSaid': 'Сервер сообщает: {message}',
            'home.group': 'Группа',
            'home.join': 'Войти',
            'home.publicGroups': 'Публичные группы',
            'menu.raiseHand': 'Поднять руку',
            'menu.unraiseHand': 'Опустить руку',
            'menu.inviteUser': 'Пригласить',
            'menu.broadcastFile': 'Транслировать файл',
            'menu.restartMedia': 'Перезапустить медиа',
            'menu.sendFile': 'Отправить файл',
            'menu.forbidPresent': 'Запретить вещание',
            'menu.allowPresent': 'Разрешить вещание',
            'menu.mute': 'Заглушить',
            'menu.kick': 'Удалить из комнаты',
            'menu.identify': 'Определить',
            'userlist.mute': 'Заглушить',
            'userlist.unmute': 'Включить звук',
            'userlist.volume': 'Громкость',
            'knock.admit': 'Впустить',
            'knock.deny': 'Отклонить',
            'toast.askingToJoin': '{who} просит впустить',
            'toast.someone': 'Кто-то',
            'toast.hostDeclined': 'Хост отклонил ваш запрос на вход',
            'toast.groupLocked': 'Комната заперта',
            'toast.muted': 'Вас заглушили',
            'toast.mutedBy': 'Вас заглушил {who}',
            'toast.noWebrtc': 'Этот браузер не поддерживает WebRTC',
            'toast.fetchStatus': 'Не удалось получить статус: {error}',
            'toast.notConnected': 'Нет подключения.',
            'toast.cantConnect': 'Не удалось подключиться к {url}',
            'toast.reconnected': 'Связь восстановлена.',
            'toast.reconnectFailed': 'Не удалось переподключиться — войдите снова.',
            'reconnect.reconnecting': 'Восстанавливаем связь…',
            'stage.noVideo': 'Никто не включил камеру.',
            'stage.onlyYou': 'В комнате только вы.',
            'chat.placeholder': 'Сообщение',
            'chat.send': 'Отправить',
            'toast.rememberOpOnly': 'Оставаться в системе на этом устройстве может только организатор.',
            'toast.rememberExpired': 'Сохранённый вход истёк — войдите снова.',
            'toast.noMedia': 'Сначала выберите камеру или микрофон.',
            'toast.settingNextCall': 'Сохранено — применится при следующем включении микрофона.',
            'toast.noDevice': 'Камера или микрофон не найдены.',
            'toast.permissionDenied': 'Доступ к камере или микрофону запрещён.',
            'toast.micEnded': 'Микрофон отключился — доступ отозван или устройство отсоединено. Включите его снова, чтобы восстановить звук.',
            'toast.enableHint': 'Включите камеру или микрофон кнопками на панели.',
            'toast.roomBusy': 'Комната занята, попробуйте позже',
            // Сквозное шифрование
            'e2ee.secure': 'Сквозное шифрование — сверьте эти эмодзи с собеседником',
            'e2ee.handshaking': 'Устанавливаю сквозное шифрование…',
            'e2ee.failed': 'Проверка шифрования не прошла — возможен перехват',
            'e2ee.multipeer': 'Сквозное шифрование работает только для двух участников',
            'e2ee.notEncrypted': 'Звонок не зашифрован',
            'e2ee.blocked': 'Включена блокировка незашифрованных соединений',
            'e2ee.blockedOverlay': 'Включена блокировка незашифрованных соединений. Этот звонок нельзя зашифровать (собеседник не поддерживает шифрование или участников больше двух), поэтому подключение заблокировано.',
            // Поддержка браузера
            'browser.unsupported': 'Этот браузер не поддерживает видеозвонки. Откройте эту ссылку в Chrome, Firefox, Safari или Edge.',
        },
    };

    const STORE_KEY = 'sozvon-lang';
    const listeners = [];

    function detect() {
        try {
            const stored = localStorage.getItem(STORE_KEY);
            if(stored && translations[stored])
                return stored;
        } catch(e) { /* localStorage may be unavailable */ }
        const nav = (navigator.languages && navigator.languages[0]) ||
            navigator.language || 'en';
        return /^ru\b/i.test(nav) ? 'ru' : 'en';
    }

    let lang = detect();

    // Deployment overrides (see static/theme/theme.js): per-language tables
    // consulted before the built-in translations, so a theme can reword any
    // key without patching this file.
    const overrides = {};

    function lookup(key) {
        for(const table of [overrides[lang], translations[lang],
                            overrides.en, translations.en]) {
            if(table && key in table)
                return table[key];
        }
        return key;
    }

    function t(key, params) {
        let s = lookup(key);
        if(params) {
            for(const k in params)
                s = s.split('{' + k + '}').join(params[k]);
        }
        return s;
    }

    // Merge per-language string overrides over the built-in translations
    // and re-translate the page.  Called by a deployment theme.
    function override(tables) {
        for(const l in tables)
            overrides[l] = Object.assign(overrides[l] || {}, tables[l]);
        apply();
    }

    function apply(root) {
        root = root || document;
        const set = (attr, fn) => root.querySelectorAll('[' + attr + ']')
            .forEach(el => fn(el, t(el.getAttribute(attr))));
        set('data-i18n', (el, v) => { el.textContent = v; });
        set('data-i18n-html', (el, v) => { el.innerHTML = v; });
        set('data-i18n-title', (el, v) => { el.title = v; });
        set('data-i18n-placeholder', (el, v) => { el.placeholder = v; });
        set('data-i18n-value', (el, v) => { el.value = v; });
        set('data-i18n-aria', (el, v) => { el.setAttribute('aria-label', v); });
        document.documentElement.setAttribute('lang', lang);
        reflectToggles();
    }

    function reflectToggles() {
        document.querySelectorAll('[data-lang-option]').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-lang-option') === lang));
        document.querySelectorAll('[data-lang-select]').forEach(s => {
            s.value = lang;
        });
    }

    function setLang(l) {
        if(!translations[l] || l === lang)
            return;
        lang = l;
        try { localStorage.setItem(STORE_KEY, l); } catch(e) { /* ignore */ }
        apply();
        listeners.forEach(fn => {
            try { fn(l); } catch(e) { console.error(e); }
        });
    }

    function onChange(fn) {
        listeners.push(fn);
    }

    function init() {
        document.querySelectorAll('[data-lang-option]').forEach(b =>
            b.addEventListener('click', e => {
                e.preventDefault();
                setLang(b.getAttribute('data-lang-option'));
            }));
        document.querySelectorAll('[data-lang-select]').forEach(s =>
            s.addEventListener('change', () => setLang(s.value)));
        apply();
    }

    window.Sozvon = window.Sozvon || {};
    window.Sozvon.i18n = {
        t, apply, setLang, onChange, override,
        get lang() { return lang; },
    };

    if(document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
