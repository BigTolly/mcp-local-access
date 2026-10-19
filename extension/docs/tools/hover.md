# browser_hover(element, ref)

Наводит курсор на центр элемента: прокрутка при необходимости, затем CDP `mouseMoved`. Срабатывают `mouseenter`/`mouseover`/`:hover` и всплывающие меню. После наведения расширение ждёт 80 мс, чтобы успели отработать CSS-переходы.

Параметры те же, что у [click](click.md).

**Ошибки**: ошибки ref, `Element s1e5 has no visible box to hover` (у элемента нет размера).
