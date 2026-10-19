# browser_type(element, ref, text, submit=false)

Заменяет содержимое поля текстом `text`. При `submit=true` после ввода нажимается Enter.

**Как работает.**

1. Агент фокусирует поле и выделяет его текущее содержимое (семантика fill). Для `<label>` берётся связанный контрол.
2. Текст вставляется через CDP `Input.insertText`, как при вводе IME. Кириллица, emoji, кавычки и любые Unicode-символы проходят без раскладки. Срабатывают `beforeinput`/`input`, React/Vue видят изменение.
3. Пустой `text` очищает поле клавишей Delete.
4. Поля `date`, `time`, `datetime-local`, `month`, `week`, `color`, `range` текстом не заполняются. Для них значение ставится нативным setter'ом с событиями `input` + `change` и проверяется: например, для date формат `2026-10-18`.
5. `submit` → настоящая клавиша Enter (keyDown/keyUp, текст `\r`).

**Ошибки**: ошибки ref; `Element is not an <input>, <textarea> or contenteditable element`; `Element is disabled or read-only`; `Input of type "file" does not accept typed text`; `The element rejected the value ...` (неверный формат даты и т.п.).

**Безопасность.** Сервер пишет в аудит только длину текста. В снимке значение пароля заменено точками.
