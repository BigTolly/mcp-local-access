# browser_network(action="list", request_id="", limit=50, part="response", max_chars=16384)

Журнал сети через CDP `Network.*`. По умолчанию выключен, тела запросов автоматически не читаются.

| action | Что делает | readOnly |
| --- | --- | --- |
| `start` | `Network.enable` (буфер Chrome 20 МБ, до 5 МБ на ресурс) и начало записи. Сбор восстанавливается после re-attach | нет |
| `stop` | `Network.disable`; собранные метаданные остаются | нет |
| `clear` | очистить журнал | нет |
| `list` | последние `limit` (1..300) запросов | да |
| `detail` | метаданные и очищенные заголовки по `request_id` | да |
| `body` | тело `part=request\|response`, до `max_chars` (1..65536) символов | да |

## list

```json
{"enabled": true, "capturingSince": "…", "total": 8, "buffered": 8, "dropped": 0, "returned": 8,
 "requests": [
  {"id": "n1", "method": "GET", "url": "http://127.0.0.1:18765/api/json?token=***", "status": 200, "type": "Fetch",
   "mimeType": "application/json", "state": "finished", "durationMs": 4, "size": 230, "error": null, "redirectedTo": null},
  {"id": "n3", "url": "…/api/redirect", "status": 302, "state": "redirected", "redirectedTo": "n4"}
 ]}
```

`id` непрозрачный: `n1`, `n2`, … Каждый шаг редиректа записывается отдельной записью со ссылками `redirectedFrom`/`redirectedTo`. Состояния: `pending`, `finished`, `failed` (с `error`, например `net::ERR_BLOCKED_BY_CLIENT`), `redirected`.

## body: когда тела нет

В этих случаях возвращается `available: false` с причиной в `reason`, без исключения:

- сбор остановлен (`stop`);
- отладчик переподключился после запроса (другое «поколение» CDP);
- редирект, запрос ещё идёт или упал;
- бинарный MIME (`application/octet-stream`, картинки, шрифты);
- тело больше 2 МБ. Тела меньше 2 МБ, но длиннее `max_chars`, возвращаются обрезанными с `truncated: true`;
- Chrome уже вытеснил тело из буфера или не сохранил post data.

## Скрытие данных (best effort)

- URL: скрываются значения query (`?token=***`), user:password и фрагмент. Хост, путь и имена параметров остаются.
- Заголовки: значения остаются только у безопасного списка (`content-type`, `cache-control`, `server`, CORS, `sec-fetch-*`, …), `location`/`referer` проходят через очистку URL, остальное заменяется на `[redacted]`.
- Тела: JSON обходится по структуре, включая JSON внутри строк. Ключи вроде `token`, `password`, `secret`, `session`, `cookie`, `api_key`, `auth` заменяются на `[redacted]`. В тексте заменяются пары `key=value`, `Bearer …` и JWT.
- **Это не гарантия обезличивания.** Секреты могут быть в пути URL, в произвольном тексте или под необычными именами полей.

## Ограничения

Запросы до `start` не восстанавливаются: чтобы увидеть запросы самой загрузки, нужно включить сбор и перезагрузить страницу. Лимит 300 записей, старые вытесняются (`dropped`). WebSocket-кадры и запросы service worker сайта не собираются; для кадров есть [browser_cdp_events](cdp-events.md) с доменом `Network`.
