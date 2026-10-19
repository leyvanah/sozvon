// What a failed install means, in the user's words.  (Sozvon, tasks#19)
//
// contrib/install.sh stops for a small, fixed set of reasons and writes each
// as a stable code to its state file.  Its own message is English, written
// for someone running the script by hand, and may name flags this app does
// not offer -- so it is shown below the sentence, for a bug report, and
// never instead of it.  Codes rather than matching the English text: that
// would break the first time a message is reworded.
//
// The Android app says the same in its string resources (install_error_*);
// desktop/test/install-errors.test.js checks that both know every code the
// installer can write.

(function (global) {
  'use strict';

  const TEXT = {
    'not-root':
      'У этой учётной записи нет прав root. Войдите на сервер как root ' +
      'или как пользователь, которому разрешён sudo без пароля.',
    'no-systemd':
      'На сервере нет systemd. Sozvon ставится на Linux с systemd — ' +
      'например, Debian или Ubuntu.',
    'unsupported-os':
      'На сервере не Linux. Sozvon ставится на Linux с systemd — ' +
      'например, Debian или Ubuntu.',
    'unsupported-arch':
      'Процессор сервера не поддерживается: готовые сборки есть только ' +
      'для x86-64 и ARM64.',
    'packages':
      'Не удалось установить нужные программы (curl, tar, openssl). ' +
      'Проверьте, что у сервера есть интернет и менеджер пакетов не занят ' +
      'другой установкой, и повторите.',
    'system-setup':
      'Не удалось подготовить систему для Sozvon. Подробности — ниже.',
    'port-in-use':
      'Нужный порт уже занят — скорее всего, на сервере работает ' +
      'веб-сервер. Остановите его или ставьте Sozvon на другой сервер. ' +
      'Какой порт — в строке ниже.',
    'version-unknown':
      'Сервер не смог узнать, какая версия Sozvon последняя: у него нет ' +
      'связи с GitHub. Проверьте его доступ в интернет и повторите.',
    'download-failed':
      'Сервер не смог скачать Sozvon. Проверьте его доступ в интернет ' +
      'и повторите.',
    'checksum-mismatch':
      'Скачанный архив не совпал с контрольной суммой, поэтому установка ' +
      'остановлена. Повторите; если ошибка вернётся, сообщите нам.',
    'unpack-failed':
      'Не удалось распаковать Sozvon на сервере. Проверьте, что на диске ' +
      'есть свободное место.',
    'public-ip-unknown':
      'Не удалось узнать внешний IP-адрес сервера, а без него не получить ' +
      'ни адрес, ни сертификат. Укажите сервер по IP-адресу или выберите ' +
      'вариант со своим доменом.',
    'certificate-failed':
      'Не удалось создать сертификат для сервера. Подробности — ниже.',
    'service-failed':
      'Sozvon установлен, но его служба не запустилась. Подробности — ' +
      'в журнале ниже.',
    'rolled-back':
      'Новая версия не запустилась, поэтому сервер возвращён к прежней — ' +
      'он работает как раньше.',
    'not-answering':
      'Sozvon установлен, но не отвечает. Чаще всего это значит, что ' +
      'Let\'s Encrypt не выдал сертификат: проверьте, что порты 80 и 443 ' +
      'открыты снаружи, а свой домен указывает на этот сервер.',
    'port-forward':
      'Sozvon установлен и работает, но сервер стоит за роутером, и снаружи ' +
      'до него не достучаться: на роутере не проброшены порты. Пробросьте ' +
      'на этот сервер порты из списка ниже и запустите установку ещё раз.',
    'internal':
      'Установщик столкнулся с внутренней ошибкой. Пришлите нам текст ' +
      'ниже — он поможет разобраться.',
    'aborted':
      'Установка неожиданно прервалась. Подробности — в журнале ниже; ' +
      'можно попробовать ещё раз.',
  };

  /**
   * The sentence for an installer failure code, or null for none: no code
   * (an installer older than the codes) or one this app does not know (an
   * installer newer than the app).  The caller then shows the installer's
   * own message, as before.
   *
   * @param {string|undefined} code
   * @returns {string|null}
   */
  function installErrorText(code) {
    return typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(TEXT, code) ? TEXT[code] : null;
  }

  if (typeof module !== 'undefined' && module.exports)
    module.exports = { TEXT, installErrorText };
  else
    global.installErrorText = installErrorText;
})(this);
