# browser_console(limit=100, level="all", clear=false)

Журнал консоли подключённой вкладки. Именно из-за него писалось расширение.

| Параметр | Описание |
| --- | --- |
| `limit` | 1..500, самые свежие записи (старые сверху) |
| `level` | `all`, `error`, `warning`, `info`, `log`, `debug`, `exception`, `navigation`, `diagnostic` |
| `clear` | вернуть текущие записи и очистить буфер (read-and-clear: ничего не теряется). В readOnly запрещено |

## Источники

| source | Событие CDP | Что это |
| --- | --- | --- |
| `console` | `Runtime.consoleAPICalled` | `console.log/info/warn/error/debug/assert/trace` |
| `exception` | `Runtime.exceptionThrown` | неперехваченные исключения и необработанные rejection |
| `browser:network`, `browser:security`, `browser:deprecation`, `browser:intervention`, `browser:violation`, ... | `Log.entryAdded` | сообщения самого Chrome: 404, CSP, CORS, mixed content, устаревшие API. **У донора их не было** |
| `navigation` | `Page.frameNavigated` (главный фрейм) | отметка «перешли на URL» |
| `diagnostic` | само расширение | Connect, detach/re-attach отладчика, восстановление после сна worker |

## Ответ

```json
{
  "version": "1.0.0", "healthy": true, "error": null,
  "tab": {"id": 123, "url": "http://127.0.0.1:18765/acceptance.html", "title": "..."},
  "level": "all", "cleared": false,
  "total": 9, "buffered": 9, "matched": 9, "returned": 9, "dropped": 0,
  "logs": [
    {"seq": 3, "time": "2026-10-18T19:00:01.120Z", "level": "error", "source": "console",
     "text": "MCP_EARLY_ERROR", "url": "http://127.0.0.1:18765/acceptance.html", "line": 7, "column": 9,
     "stack": "    at (anonymous) (http://127.0.0.1:18765/acceptance.html:7:9)"},
    {"seq": 4, "level": "exception", "source": "exception", "text": "Uncaught Error: MCP_EARLY_EXCEPTION", "line": 11}
  ],
  "lastDetach": null
}
```

`healthy=false` означает, что отладчик не подключён или не подписан на Runtime/Log. Причина лежит в `error`. Пустой `logs` при `healthy=true` значит, что сообщений действительно не было.

## Как исправлены баги донора

1. **Отладчик подключается при Connect**, и `Runtime.enable` + `Log.enable` включаются сразу. При включении Chrome отдаёт и уже накопленную историю (как DevTools, открытые после загрузки).
2. **Нет очистки на `status=complete`.** При навигации ставится отметка, как «Preserve log» в DevTools. Ошибки во время загрузки (`MCP_EARLY_*`) сохраняются.
3. **Log domain** добавлен.
4. **Жизненный цикл**: `onDetach` фиксируется, через 1 с делается re-attach, и каждое чтение сначала вызывает `cdp.ensure()`. После сна service worker делается `Runtime/Log.disable` + `enable`, чтобы Chrome заново отдал историю. Дубликаты отсеиваются по ключу (время + тип + текст).
5. **Честный статус**: `healthy`, `error`, `dropped`, `lastDetach`.

## Ограничения

- Буфер вмещает 1000 записей на вкладку, инструмент отдаёт до 500 за раз. Текст обрезается до 10 000 символов, стек до 12 кадров.
- Буфер живёт в памяти service worker. При перезапуске worker история частично восстанавливается из Chrome; в промежутке можно потерять события, и это отмечается записью `diagnostic`.
- Собирается главная CDP-цель вкладки. Консоль внешних (out-of-process) iframe, worker'ов и service worker сайта не агрегируется. Консоль самего расширения сюда не попадает.
