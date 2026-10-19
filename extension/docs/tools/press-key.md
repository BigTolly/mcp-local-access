# browser_press_key(key)

Нажимает клавишу или комбинацию в элементе, который сейчас в фокусе. События доверенные, через CDP `Input.dispatchKeyEvent`.

**Формат `key`:**

- имена из UI Events: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowLeft/Up/Right/Down`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `F1`..`F12`, `Space` или `" "`;
- один символ: `a`, `7`, `/`, `ё`, `🚀`;
- комбинации через `+`: `Control+a`, `Control+Shift+ArrowLeft`, `Shift+Tab`, `Control++`;
- синонимы: `Ctrl`, `Cmd`/`Command`/`Win` (= Meta), `Option` (= Alt), `Esc`, `Return`, `Del`, `Up`/`Down`/`Left`/`Right`, `PgUp`/`PgDn`.

**Поведение.** Модификаторы нажимаются по порядку и отпускаются в обратном. **Всё, что было нажато, отпускается в `finally`**, даже если в середине комбинации случилась ошибка. У донора в такой ситуации Ctrl/Shift оставались зажатыми. С Ctrl/Alt/Meta текст не вставляется, срабатывают сочетания. `Shift+a` даёт `A`.

**Ошибки**: `Unknown key: "X"`, `Unknown modifier: "X" (use Control, Shift, Alt or Meta)`. В этих случаях ничего не нажимается.

**Ограничения.** Раскладка US: для символов вне ASCII `code` пустой, передаётся только текст. Системные сочетания браузера (Ctrl+T, Ctrl+W) страница получает, но Chrome их не выполняет.
