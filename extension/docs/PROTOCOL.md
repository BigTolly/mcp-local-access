# Протокол обмена Browser Control ↔ Local Access

Источник истины: `server.py`, класс `BrowserBridge` и функции `browser_*`. Если код сервера меняется, этот файл нужно синхронизировать.

## Транспорт

- Сервер: WebSocket `ws://localhost:9009` (порт из `config.json`, секция `browser`). Максимум 64 МБ на сообщение, ping каждые 20 с.
- Расширение: клиент. Новое подключение вытесняет старое, поэтому донор и Browser Control нельзя держать включёнными одновременно.
- Таймаут сервера на ответ: 30 с по умолчанию (`timeoutSeconds`), 5 с для `browser_diagnostics` из `browser_status`.

## Агентская сессия (1.0.0, `browser_launch`)

- Сервер запускает Chrome на `http://<host>:<port>/bc-launch#<token>`; тот же порт отдаёт на `GET /bc-launch` HTML-страницу (websockets 13+). Токен в фрагменте, на сервер по HTTP не уходит.
- Проба: `ws://host:port/?launch=<token>&probe=1`. Верный токен → сообщение `{"type":"launchAccepted"}` и закрытие 1000; иначе закрытие **4403**. Проба не заменяет текущее соединение.
- Рабочее соединение сессии: `ws://host:port/?launch=<token>`. Пока сессия активна, соединение без токена закрывается с **4409**, с чужим токеном с **4403**.
- Сессия отпускает мост, когда её соединение закрыто чисто (1000: вкладка закрыта, Disconnect) или Chrome агента завершился. Обрыв (рестарт service worker) мост не отпускает: расширение возвращается с тем же токеном.

## Формат сообщений

Запрос сервера:

```json
{"id": "9f2c...", "type": "browser_click", "payload": {"element": "Submit", "ref": "s3e12"}}
```

У `getUrl` и `getTitle` поля `payload` нет совсем.

Успешный ответ расширения:

```json
{"type": "messageResponse", "payload": {"requestId": "9f2c...", "result": null}}
```

Ошибка:

```json
{"type": "messageResponse", "payload": {"requestId": "9f2c...", "error": "Stale aria-ref, ..."}}
```

Любые другие сообщения от расширения сервер игнорирует. Browser Control использует это для keepalive:

```json
{"type": "keepalive", "payload": {"ts": 1760800000000}}
```

## Контрактные строки ошибок

| Строка | Когда | Зачем дословно |
| --- | --- | --- |
| `No tab is connected` | нет подключённой вкладки | сервер заменяет её на подсказку для ИИ |
| `Stale aria-ref, expected s<G>e<N>, got <ref>. Please regenerate an aria snapshot before trying again.` | ref из старого снимка | совместимость с донором |
| `Element with aria-ref <ref> not found` | ref не найден | совместимость |
| `Unable to find option for value: <v>` | нет опции в select | совместимость |
| `Unknown key: <key>` | неизвестная клавиша | совместимость |

## Команды

| type | payload | result | Инструмент MCP |
| --- | --- | --- | --- |
| `getUrl` | нет | `string` | внутри snapshot |
| `getTitle` | нет | `string` | внутри snapshot |
| `browser_snapshot` | `{}` | YAML-строка с ref | browser_snapshot + после каждого действия |
| `browser_navigate` | `{url}` | `null` | browser_navigate |
| `browser_go_back` | `{}` | `null` | browser_go_back |
| `browser_go_forward` | `{}` | `null` | browser_go_forward |
| `browser_press_key` | `{key}` | `null` | browser_press_key |
| `browser_click` | `{element, ref}` | `null` | browser_click |
| `browser_hover` | `{element, ref}` | `null` | browser_hover |
| `browser_drag` | `{startElement, startRef, endElement, endRef}` | `null` | browser_drag |
| `browser_type` | `{element, ref, text, submit}` | `null` | browser_type |
| `browser_select_option` | `{element, ref, values[]}` | `null` | browser_select_option |
| `browser_screenshot` | `{}` | base64 PNG (можно с `data:` префиксом) | browser_screenshot |
| `browser_get_console_logs` | `{}` | массив записей | browser_get_console_logs |
| `browser_diagnostics` | `{}` | объект состояния | browser_diagnostics, browser_status |
| `browser_console` | `{limit, level, clear}` | `{healthy, logs[], dropped, lastDetach}` | browser_console |
| `browser_network` | `{action, request_id, limit, part, max_chars}` | зависит от action | browser_network |
| `browser_capture` | `{mode, scale}` | base64 PNG **без** `data:` префикса (сервер проверяет сигнатуру) | browser_capture |
| `browser_cdp` | `{method, params}` | результат CDP как есть |
| `browser_evaluate` | `{expression, awaitPromise}` | `{value, type, exception?}` |
| `browser_cdp_events` | `{domain, action, limit}` | `{subscribed[], events[], dropped}` |
| `browser_close_tab` | `{}` | `{closedTabId, remainingTabs, remainingWindows}`; вкладка закрывается сразу после ответа. Вне агентской сессии: ошибка | browser_close |

`browser_wait` и `browser_status` выполняются на сервере, расширение в них не участвует (status только зовёт `browser_diagnostics`).
`browser_launch` и решение о завершении Chrome по PID целиком на сервере.

Детали каждой команды: `docs/tools/<инструмент>.md` (появляются по мере закрытия этапов).
