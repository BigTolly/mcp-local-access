# browser_drag(start_element, start_ref, end_element, end_ref)

Перетаскивает элемент `start_ref` на `end_ref`. В протоколе payload выглядит так: `{startElement, startRef, endElement, endRef}`.

**Как работает.**

1. Координаты обоих элементов; старт пересчитывается после возможной прокрутки к цели.
2. `Input.setInterceptDrags(true)`: Chrome отдаёт начатый HTML5-drag расширению событием `Input.dragIntercepted`.
3. Нажатие и 8 шагов `mouseMoved` к цели.
4. **HTML5 drag-and-drop** (был перехват): `Input.dispatchDragEvent` `dragEnter` → `dragOver` → `drop` с данными перетаскивания. **Мышиный drag** (sortable-списки, слайдеры, canvas): просто движение до цели.
5. В `finally`: `mouseReleased` и `setInterceptDrags(false)`. Кнопка мыши не остаётся зажатой, даже если по дороге случилась ошибка.

**Ошибки**: ошибки ref, `Both drag elements must be visible on the page`.

**Ограничения.** Оба элемента должны помещаться в окно одновременно. Перетаскивание файлов из ОС не поддерживается.
