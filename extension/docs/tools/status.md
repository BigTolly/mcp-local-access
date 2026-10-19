# browser_status()

Выполняется на сервере. Проверяет, слушает ли `server.py` порт 9009 и подключено ли расширение. Если WebSocket открыт, сервер зовёт `browser_diagnostics` с таймаутом 5 с и дописывает его JSON.

- Связь есть только пока вкладка подключена: Browser Control открывает WebSocket при Connect и закрывает при Disconnect/закрытии вкладки.
- «WebSocket connected, but tab/debugger diagnostics are unavailable» означает старое расширение (Browser MCP без диагностики) или зависший отладчик.
- Главное поле в ответе: `debuggerReady`. См. [diagnostics.md](diagnostics.md).
