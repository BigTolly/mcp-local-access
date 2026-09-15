# Быстрый старт

1. В первом терминале запускаем сервер MCP:
cd C:\usr\mcp\local-access
python .\server.py

2. Во втором терминале запускаем CloudFlare
cloudflared tunnel --url http://localhost:8000 --protocol http2

3. Берем из CloudFlare url и добавляем в конец "/mcp", пример:

Requesting new quick Tunnel on trycloudflare.com...
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://verbal-univ-silent-bracelet.trycloudflare.com                                     |
+--------------------------------------------------------------------------------------------+

получаем: https://verbal-univ-silent-bracelet.trycloudflare.com/mcp

4. В Notion переходим в Setting > Connections > Custom MCP

5. Указываем "MCP server URL": https://verbal-univ-silent-bracelet.trycloudflare.com/mcp

6. В "Name" пишем любое имя например: "Local Access"

7. Меняем метод авторизации в "Authentication" выбираем "Bearer token"

8. В поле "Token" вставляем токен из .env

9. Нажимаем "Connect" после чего должно произойти подключение.

10. Включаем выполнение инструментов без подтверждения:
В той же вкладке кликаем Installed и видим наш MCP, кликаем по этому MCP, затем по "Notion Agent"
и меняем "Always ask" на "Run automatically"
