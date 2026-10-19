# browser_go_back() / browser_go_forward()

Шаг назад или вперёд по истории подключённой вкладки. Параметров нет.

**Как работает.** CDP `Page.getNavigationHistory` → проверка, что соседняя запись есть → `Page.navigateToHistoryEntry`. Ожидание такое же, как у [navigate](navigate.md), и включает восстановление из back/forward cache и переходы внутри документа (`#hash`, `pushState`).

**Ошибки**: `Cannot go back: there is no previous page in this tab's history`, `Cannot go forward: there is no next page in this tab's history`. Донор в этой ситуации молча ничего не делал.
