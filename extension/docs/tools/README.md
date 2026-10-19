# Инструменты Browser Control

Каждый MCP-инструмент `browser_*` живёт в `server.py` и отправляет расширению одну или несколько команд (см. [PROTOCOL.md](../PROTOCOL.md)). После любого действия сервер сам запрашивает `getUrl`, `getTitle` и `browser_snapshot` и возвращает ИИ свежий снимок.

| Инструмент | Где выполняется | Документ |
| --- | --- | --- |
| browser_status | сервер + `browser_diagnostics` | [status.md](status.md) |
| browser_navigate | расширение (CDP Page) | [navigate.md](navigate.md) |
| browser_go_back / browser_go_forward | расширение (CDP Page) | [history.md](history.md) |
| browser_wait | сервер | [wait.md](wait.md) |
| browser_snapshot | расширение (агент страницы) | [snapshot.md](snapshot.md) |
| browser_click | расширение (CDP Input) | [click.md](click.md) |
| browser_hover | расширение (CDP Input) | [hover.md](hover.md) |
| browser_drag | расширение (CDP Input) | [drag.md](drag.md) |
| browser_type | расширение (агент + CDP Input) | [type.md](type.md) |
| browser_select_option | расширение (агент) | [select-option.md](select-option.md) |
| browser_press_key | расширение (CDP Input) | [press-key.md](press-key.md) |
| browser_screenshot | расширение (CDP Page) | [screenshot.md](screenshot.md) |
| browser_capture | расширение (CDP Page) | [capture.md](capture.md) |
| browser_get_console_logs | расширение (буфер консоли) | [get-console-logs.md](get-console-logs.md) |
| browser_console | расширение (буфер консоли) | [console.md](console.md) |
| browser_network | расширение (CDP Network) | [network.md](network.md) |
| browser_diagnostics | расширение | [diagnostics.md](diagnostics.md) |
| browser_cdp | расширение (любой CDP) | [cdp.md](cdp.md) |
| browser_evaluate | расширение (CDP Runtime) | [evaluate.md](evaluate.md) |
| browser_cdp_events | расширение (события CDP) | [cdp-events.md](cdp-events.md) |

Общие правила:

- Без подключённой вкладки расширение отвечает `No tab is connected`, сервер превращает это в подсказку «нажмите Connect».
- Действия выполняются по очереди, чтение (консоль, сеть, диагностика, события CDP, URL) не ждёт действий.
- В `readOnly` сервер запрещает действия и изменение сбора; чтение разрешено.
- Ответ сервера обрезается по `MAX_RESPONSE_CHARS` (функция `clamp`).
