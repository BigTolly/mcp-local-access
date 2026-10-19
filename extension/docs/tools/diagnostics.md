# browser_diagnostics()

Полное состояние расширения. Сервер также вставляет его в `browser_status`. Тот же JSON показывает кнопка «Run diagnostics» в popup.

| Поле | Смысл |
| --- | --- |
| `version`, `chrome` | версия расширения и Chrome |
| `workerStartedAt`, `uptimeSec` | когда стартовал service worker: если недавно, буферы могли обнулиться |
| `bridge` | статус WebSocket, URL, число переподключений, последняя ошибка и код закрытия |
| `session` | подключённая вкладка, счётчик снимков, последнее отключение и его причина |
| `tab` | id, URL, title, status вкладки |
| **`debuggerReady`** | `true`, только если прошёл реальный round-trip к CDP и включены Runtime + Log |
| `probe` | `Runtime.evaluate("1")`: ok, время в мс, ошибка |
| `debugger` | attached, generation, включённые и нужные домены, ошибки `enable`, `lastDetach` (причина и время), `reattachCount`, счётчик событий |
| `console` | размер буфера, `dropped`, отсеянные дубликаты, счётчики по уровням, последнее событие |
| `network` | включён ли сбор, размер, `dropped` |
| `cdpEvents` | подписанные домены и размер буфера |
| `recentCommands` | последние 10 команд: тип, успех, время, ошибка |

Инструмент ничего не меняет, но если отладчик отвалился, probe переподключит его. Так чтение диагностики одновременно восстанавливает сбор. Чтение идёт параллельно с действиями и не ждёт очереди.

**Типичные диагнозы**

| Симптом | Причина |
| --- | --- |
| `probe.error` содержит `Another debugger client` | вкладку держит другое расширение (Browser MCP): отключите его |
| `lastDetach.reason = canceled_by_user`, `debugger.pausedByUser` задан | нажали «Отмена» или крестик на плашке отладки; вкладка на паузе, любая команда (в том числе этот probe) подключит отладчик снова. Если в popup включена галочка «…disconnects the tab», вкладка отключена и нужен Connect |
| `probe.error` содержит `Cannot access a chrome:// URL` | вкладка стоит на защищённой странице; `browser_navigate` на обычный URL или `browser_go_back` вернёт её |
| `bridge.status = closed`, `retryAttempt` растёт | не запущен `server.py` или не тот порт |
| Частые `reconnects` | порт 9009 делят два расширения, и сервер по очереди вытесняет то одно, то другое |
