# browser_cdp(method, params={})

Одна команда [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) для подключённой вкладки. Идёт через тот же `chrome.debugger`, что и остальные инструменты, и возвращает JSON-результат без изменений.

**Примеры**

| Задача | method | params |
| --- | --- | --- |
| DOM-дерево | `DOM.getDocument` | `{"depth": 3}` |
| Вычисленные стили узла | `CSS.getComputedStyleForNode` | `{"nodeId": 42}` (сначала `DOM.enable`, `CSS.enable`) |
| Метрики производительности | `Performance.getMetrics` | `{}` (после `Performance.enable`) |
| Куки страницы | `Network.getCookies` | `{}` |
| Мобильная эмуляция | `Emulation.setDeviceMetricsOverride` | `{"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": true}` |
| Двойной клик | `Input.dispatchMouseEvent` | `{"type": "mousePressed", "x": 100, "y": 200, "button": "left", "clickCount": 2}` |
| Исходник скрипта | `Debugger.getScriptSource` | `{"scriptId": "…"}` (после `Debugger.enable`) |
| Снимок accessibility-дерева Chrome | `Accessibility.getFullAXTree` | `{}` |

**Запрещено**

| Что | Почему |
| --- | --- |
| `Browser.*`, `Target.*`, `SystemInfo.*`, `Tethering.*`, `Extensions.*`, `PWA.*` | выходят за пределы подключённой вкладки |
| `Page.close`, `Page.crash` | закрывают или роняют вкладку |
| `Network.getAllCookies`, `Storage.getCookies`, `Storage.setCookies`, `Storage.clearCookies`, `Network.clearBrowserCookies`, `Network.clearBrowserCache`, `Storage.clearDataForOrigin`, `Storage.clearDataForStorageKey`; `Network.getCookies` с параметром `urls` | читают или стирают данные **всех** сайтов браузера. Куки текущей страницы: `Network.getCookies` без параметров |
| `Network.loadNetworkResource` | читает любой URL (другие сайты, интранет, localhost) в обход CORS. Для запросов от имени страницы: `browser_evaluate` + `fetch()` |
| `Network.setCookie`, `Network.setCookies`, `Network.deleteCookies` с `domain`/`url` другого сайта | писать и удалять куки можно только для сайта текущей вкладки и его поддоменов |
| параметры `origin`, `securityOrigin`, `storageKey` чужого origin (`Storage.getUsageAndQuota`, `CacheStorage.*`, `IndexedDB.*`, ...) | хранилище других сайтов закрыто |
| `Page.navigate` на `chrome://`, Web Store, `javascript:`, `file://`; `Page.navigateToHistoryEntry` на такую запись | те же правила, что у [browser_navigate](navigate.md) |
| `Runtime.disable`, `Log.disable`, `Page.disable` | остановят сбор консоли и навигации |
| `Network.enable/disable` | для этого есть `browser_network start/stop`: иначе сбор рассинхронизируется |

Chrome и сам ограничивает `chrome.debugger` одной вкладкой и некоторыми доменами. Его отказ приходит текстом вида `Domain.method: …`.

**readOnly** (проверяет сервер): разрешены только методы `get*`, `describe*`, `query*`, `search*`, `resolve*`. Браузерные куки/хранилище, `loadNetworkResource` и `Page.navigate` на `javascript:`/`file://` сервер запрещает сам в любом режиме, даже со старым расширением.

**Состояние между вызовами.** Домены, включённые через `X.enable`, остаются включёнными до detach. После re-attach восстанавливаются только домены из [browser_cdp_events](cdp-events.md) и служебные (Page, Runtime, Log, Network). Эмуляция и другие override сбрасываются при Disconnect.

**Аудит**: пишется только имя метода, параметры не логируются.
