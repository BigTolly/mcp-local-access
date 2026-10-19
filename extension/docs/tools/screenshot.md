# browser_screenshot()

Старый инструмент, совместимый с донором. PNG видимой области (viewport), вписанный в 1024×768 с сохранением пропорций. Это то же, что `browser_capture(mode="viewport", scale="reduced")`.

Уменьшение делает сам Chrome (`Page.captureScreenshot` с `clip.scale`), canvas для этого не нужен.

Для снимка без уменьшения или всей страницы целиком см. [capture.md](capture.md).
