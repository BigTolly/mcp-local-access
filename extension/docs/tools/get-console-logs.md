# browser_get_console_logs()

Старый инструмент для совместимости: возвращает массив до 500 последних записей. Сервер печатает каждую запись отдельной JSON-строкой:

```json
{"type": "error", "timestamp": "2026-10-18T19:00:01.120Z", "message": "MCP_EARLY_ERROR", "url": "http://…/acceptance.html", "line": 7}
```

Источник данных тот же, что у [browser_console](console.md). Если сбор не работает, **первой строкой идёт `{"type": "diagnostic", "message": "Console capture is NOT active: …"}`**. Пустой ответ `(no console messages)` больше не может скрывать сломанную подписку, как было у донора.

Для фильтра по уровню, очистки и статуса сбора пользуйтесь `browser_console`.
