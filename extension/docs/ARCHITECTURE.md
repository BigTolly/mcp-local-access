# Архитектура Browser Control

## Схема

```
 ИИ (Notion, claude.ai, ...)
      │  MCP over HTTPS
 server.py (Local Access) ── ws://localhost:9009 (сервер) ──┐
                                                            │ WebSocket
 ┌────────────────────── Browser Control (service worker) ──────┴──┐
 │ bridge.js ── router.js ── tools/*.js                            │
 │                   │            │                                │
 │              session.js     cdp.js ── chrome.debugger (CDP 1.3)   │
 │                   │            │                                │
 │               icon.js     page-agent.js ── chrome.scripting       │
 │                   │                           │                 │
 │        offscreen/theme (prefers-color-scheme)   │                 │
 └─────────────────────────────────────────────────┼─────────────────┘
                                                   ▼
                                  вкладка: src/page/agent.js (isolated world)
```

## Компоненты

| Файл | Ответственность |
| --- | --- |
| `src/background/service-worker.js` | точка входа: создаёт объекты, регистрирует все слушатели chrome.* синхронно, восстанавливает сессию |
| `src/background/bridge.js` | WebSocket-клиент: переподключение с backoff, keepalive каждые 20 с |
| `src/background/router.js` | `type` → обработчик, формирует `messageResponse`, сериализует действия, журнал команд |
| `src/background/session.js` | какая вкладка подключена; Connect/Disconnect; хранение в `storage.session` |
| `src/background/cdp.js` | жизненный цикл `chrome.debugger`: attach, включение доменов, onDetach, re-attach, рассылка событий |
| `src/background/page-agent.js` | внедрение и вызов `src/page/agent.js` через `chrome.scripting` |
| `src/background/icon.js` | иконка на панели: цвет темы, зелёная на подключённой вкладке |
| `src/background/theme.js` | offscreen-документ для `prefers-color-scheme` |
| `src/background/wait.js` | ожидание навигации и готовности вкладки |
| `src/tools/*.js` | обработчики команд, по файлу на группу |
| `src/shared/*.js` | чистая логика без chrome.*: буферы, формат консоли, redaction, клавиатура, растр иконки. Покрыта unit-тестами |
| `src/page/agent.js` | классический скрипт в странице: ARIA-snapshot, ref → элемент, фокус, select, ожидание стабильного DOM |
| `src/popup/*` | интерфейс: статус, Connect/Disconnect, порт, диагностика |
| `src/offscreen/*` | слушает тему ОС/Chrome и сообщает её service worker |

## Принципы

1. **Отладчик подключается сразу при Connect**, а не при первом действии. Только так консоль видит ошибки во время загрузки. `Runtime.enable` и `Log.enable` при включении отдают и уже накопленные браузером сообщения.
2. **Никакого тихого сбоя.** Потеря отладчика фиксируется (`lastDetach`), при следующей команде делается re-attach и повторное включение всех нужных доменов. Чтение консоли возвращает `healthy`, а не пустой список.
3. **Буферы не чистятся при навигации.** Вместо этого ставится отметка `navigation` (как «Preserve log» в DevTools). Очистка только явная.
4. **Контракт с server.py не меняется** для существующих команд: те же `type`, payload и строки ошибок (см. PROTOCOL.md).
5. **Доверенный ввод.** Мышь и клавиатура идут через `Input.*` CDP (`isTrusted=true`), а не через `dispatchEvent`. DOM-обход только для невидимых элементов и специальных полей (date, color, range).
6. **Изолированный мир.** Агент страницы живёт в isolated world расширения: сайт не видит его и не может подменить. Контент-скрипт на всех сайтах не нужен, внедрение идёт только в подключённую вкладку.

## Жизненный цикл

1. **Connect** (popup): `session.connect(tabId)` → проверка URL → `cdp.ensure()` (attach + Page/Runtime/Log) → `bridge.start()` → иконка.
2. **Работа**: server.py шлёт запрос → router → обработчик → `messageResponse`. Действия (клик, ввод, навигация) идут строго по очереди; чтение (диагностика, консоль, URL) идёт параллельно.
3. **Сон service worker**: WebSocket с трафиком раз в 20 с держит его живым (Chrome 116+). Если всё же уснул, `chrome.alarms` раз в 30 с его будит, а `session.restore()` поднимает подключение из `storage.session`. Буферы консоли при этом восстанавливаются из истории V8 (повторный `Runtime.enable`), сетевой журнал теряется.
4. **Detach**: `target_closed` → попытка re-attach через 1 с, если вкладка жива, и ещё раз на `tabs.onUpdated(loading)`, когда вкладка уходит с защищённой страницы. `canceled_by_user` («Отмена» **или** крестик на плашке, для Chrome это одно событие) → по умолчанию **пауза** (`cdp.pausedByUser`): сессия и WebSocket остаются, авто-re-attach не делается (иначе плашка тут же вернётся), следующая команда делает `ensure()`. Пауза хранится в `storage.session` и переживает рестарт worker. Настройка `bcSettings.barCancel = 'disconnect'` возвращает полный Disconnect.
5. **Закрытие вкладки** → Disconnect, WebSocket закрывается, сервер видит «no tab connected».

## Известные ограничения

- Одна подключённая вкладка за раз (как у донора и как ждёт server.py).
- Содержимое iframe в snapshot не раскрывается (виден сам узел `iframe`), CDP-сессии дочерних фреймов и воркеров не агрегируются.
- Страницы `chrome://`, Chrome Web Store, `view-source:` и другие расширения автоматизировать нельзя: это запрет Chrome.
- `browser_navigate` на такие страницы и на `javascript:` отказывает заранее; если вкладка уже там, navigate/go_back/go_forward работают через `chrome.tabs` без отладчика.
- Пока отладчик подключён, Chrome показывает плашку «Browser Control начал отладку этого браузера» **во всех вкладках** (глобальная плашка Chrome). Скрыть её из расширения нельзя, отличить «Отмену» от крестика тоже.
