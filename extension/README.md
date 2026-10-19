# Browser Control

Расширение Chrome для управления браузером из MCP-сервера Local Access.

## Возможности

- **21 инструмент** существенно расширяет функционал MCP Local Access.
- **Надёжная консоль**: Runtime + Log, ошибки во время загрузки, история до Connect, восстановление после detach и сна worker, честный статус `healthy`.
- **Протокол DevTools**: `browser_cdp` (любая команда в пределах вкладки), `browser_evaluate` (JS как в консоли DevTools), `browser_cdp_events` (подписки на события).
- **Доверенный ввод** через CDP Input; клавиши никогда не залипают; HTML5 drag-and-drop.
- **Агентский браузер**: `browser_launch` сам открывает Chrome, вкладка `localhost:<порт>/bc-launch#<токен>` и подключается к ней после проверки токена у сервера, а `browser_close` закрывает её. Возможно подключение к любой вкладке через Connect. Протокол: [docs/PROTOCOL.md](docs/PROTOCOL.md), режимы запуска: README.md проекта.

## Установка

1. Включить «Режим разработчика» → «Загрузить распакованное» → папка `C:\usr\mcp\local-access\extension`.
2. Запустить MCP сервер Local Access.
3. Открыть вкладку в браузере → иконка Browser Control (Alt+J). После подключения, сверху страницы Chrome покажет плашку «начал отладку», при нажатии на «Отмена» или крестик на плашке поставят отладчик на паузу, но вкладка остаётся подключённой.
5. Иконка стала зелёной: значит, сервер на связи.

Убрать плашку можно флагом запуска Chrome `--silent-debugger-extension-api`:

## Разработка

```
node tools/check.mjs              # статические проверки
node --test "tests/*.test.mjs"    # тесты (bridge.test нужен python + websockets)
node tools/make-icons.mjs --ascii # пересобрать иконки после правки src/shared/icon-raster.js
```

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): компоненты, жизненный цикл, ограничения.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): контракт с `server.py`.
- [docs/tools/](docs/tools/README.md): по файлу на каждый инструмент.
