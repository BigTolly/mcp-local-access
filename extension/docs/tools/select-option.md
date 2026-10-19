# browser_select_option(element, ref, values)

Выбирает опции в `<select>`. В обычном select берётся первое значение из `values`, в `multiple` выбираются все переданные, а остальные снимаются.

**Сопоставление** идёт по порядку: `option.value`, затем видимый текст, затем `label`. Так ИИ может передать и `"m"`, и `"Medium"`. После выбора срабатывают события `input` и `change`.

**Ошибки**: `Unable to find option for value: X` (как у донора), `Option is disabled: X`, `Element is not a <select> element: s1e4`, `values must contain at least one value`.

**Ограничения.** Кастомные выпадающие списки на div (`role=listbox`, MUI, Select2) так не выбираются. Их нужно открыть [click](click.md) и кликнуть по нужному `option`.
