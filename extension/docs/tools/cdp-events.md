# browser_cdp_events(action="read", domain="", limit=100)

Подписка на «сырые» события DevTools Protocol и их чтение. Дополняет [browser_cdp](cdp.md): тот только отправляет команды, а этот слушает.

| action | Что делает | readOnly |
| --- | --- | --- |
| `subscribe` | запоминать события домена `domain` и вызвать `domain.enable`. После re-attach домен включается снова | нет |
| `unsubscribe` | перестать записывать; `disable`, если домен включали мы | нет |
| `clear` | очистить буфер | нет |
| `read` | последние `limit` (1..500) событий; `domain` работает как фильтр | да |

```json
{"subscribed": ["Performance"], "buffered": 3, "total": 3, "dropped": 0, "returned": 3,
 "events": [{"seq": 1, "time": "…", "method": "Performance.metrics", "params": {"metrics": […], "title": "…"}}]}
```

**Примеры доменов**: `Performance`, `DOM` (изменения дерева), `Animation`, `Audits` (issues из панели Issues), `Security`, `ServiceWorker`, `Media`, `Network` (все сетевые события, включая WebSocket-кадры; идут только пока включён `browser_network start`). Домены `Page`, `Runtime`, `Log` расширение держит включёнными всегда, на них можно просто подписаться.

**Лимиты.** 1000 событий в буфере, старые вытесняются (`dropped`). `params` длиннее 4000 символов JSON заменяются на `{truncated, length, preview}`. События **не проходят через redaction**: сетевые события содержат заголовки и куки как есть.
