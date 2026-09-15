# Quick start

1. In the first terminal start the MCP server:
cd C:\usr\mcp\local-access
python .\server.py

2. In the second terminal start CloudFlare
cloudflared tunnel --url http://localhost:8000 --protocol http2

3. Take the url from CloudFlare and add "/mcp" at the end, example:

Requesting new quick Tunnel on trycloudflare.com...
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://verbal-univ-silent-bracelet.trycloudflare.com                                     |
+--------------------------------------------------------------------------------------------+

we get: https://verbal-univ-silent-bracelet.trycloudflare.com/mcp

4. In Notion go to Setting > Connections > Custom MCP

5. Fill in the "MCP server URL": https://verbal-univ-silent-bracelet.trycloudflare.com/mcp

6. In "Name" write any name, for example: "Local Access"

7. Change the authorization method: in "Authentication" choose "Bearer token"

8. In the "Token" field paste the token from .env

9. Click "Connect", after which the connection should be established.

10. Enable running tools without confirmation:
In the same tab click Installed and see our MCP, click on this MCP, then on "Notion Agent"
and change "Always ask" to "Run automatically"
