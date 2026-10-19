# browser_evaluate(expression, await_promise=true)

Выполняет JavaScript в странице так же, как консоль DevTools: CDP `Runtime.evaluate` с `replMode` (работает top-level `await`, можно повторно объявлять `let`), `userGesture` (можно то, что требует жеста пользователя) и обходом CSP для eval. Код выполняется в **главном мире страницы** и видит её переменные (`window.app`, React DevTools hook и т.п.).

**Ответ**

```json
{"ok": true, "type": "string", "value": "Local Access Diagnostics acceptance"}
{"ok": true, "type": "object", "subtype": "node", "description": "h1"}
{"ok": false, "exception": {"text": "ReferenceError: foo is not defined\n    at <anonymous>:1:1", "line": 1, "column": 1}}
```

- Сериализуемые значения возвращаются как JSON (`value`).
- Для DOM-узлов, функций и циклических объектов идёт повтор без `returnByValue` и возвращается `description` в формате превью DevTools.
- Исключения и отклонённые Promise возвращаются с `ok: false` и не роняют инструмент.

**Советы.** Верните данные сами: `JSON.stringify(...)`, `[...document.querySelectorAll('a')].map(a => a.href)`. Большие объекты сервер обрежет (`clamp`). Таймаут 30 с.

**Безопасность.** Это полный доступ к странице от вашего имени, с куками и сессией. В readOnly сервер инструмент запрещает. В аудит пишется только длина выражения.
