# browser_snapshot()

ARIA-снимок страницы в YAML. Из него ИИ берёт `ref` элементов для click/type/hover/drag/select. Сервер добавляет в ответ URL (`getUrl`) и заголовок (`getTitle`).

```yaml
- banner [ref=s4e1]:
  - heading "Local Access Diagnostics acceptance" [level=1] [ref=s4e2]
- button "Emit log/warn/error" [ref=s4e3]
- textbox "Email" [required] [ref=s4e7]: user@example.com
- checkbox "Agree" [checked] [ref=s4e8]
- combobox "Size" [ref=s4e9]:
  - value: Medium
  - option "Small" [ref=s4e10]
  - option "Medium" [selected] [ref=s4e11]
- link "Docs" [ref=s4e12]:
  - /url: /docs
- generic [cursor=pointer] [ref=s4e13]: Open menu
- text: Plain text between elements
```

**Ссылки.** Формат `s<поколение>e<номер>`. Поколение растёт с каждым снимком и хранится в service worker, поэтому ref из старого снимка или с другой страницы всегда отклоняется:

- `Stale aria-ref, expected s5e3, got s4e3. Please regenerate an aria snapshot before trying again.`
- `Element with aria-ref s5e99 not found` (элемента нет или он удалён из DOM)
- `No snapshot found. Please generate an aria snapshot before trying again.` (на этой странице снимка ещё не было)
- `Invalid aria-ref selector, should be of form s<number>e<number>`

**Что попадает в снимок.** Элементы с ARIA-ролью (явной или неявной по HTML-AAM), их имя (aria-labelledby, aria-label, label, placeholder, alt, текст) и состояния: `level`, `checked`, `disabled`, `expanded`, `pressed`, `selected`, `required`, `active` (фокус). Значения полей идут после двоеточия, пароль заменяется точками. У ссылок есть строка `/url`.

**Новое по сравнению с донором.** Кликабельные `div`/`span` без роли (`cursor: pointer`) получают узел `generic [cursor=pointer]` со своим ref. Без этого на SPA половина кнопок недоступна.

**Что не попадает.** `display:none`, `aria-hidden="true"`, `visibility:hidden`, скрипты и стили, содержимое SVG/canvas/video. Закрытые shadow root и содержимое iframe (сам iframe виден как узел). Открытые shadow root и слоты обходятся.

**Лимиты.** 5000 элементов (дальше строка `snapshot truncated`), имя до 200 символов, текст до 400. Сервер дополнительно обрезает ответ.

**Реализация.** `src/page/agent.js` внедряется в isolated world вкладки при первой нужде. Перед снимком расширение ждёт `status=complete` (до 10 с). Если документ перезагружается прямо во время вызова, делается до трёх попыток.
