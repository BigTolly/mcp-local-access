@echo off
start "Cloudflared Tunnel" cmd /k cloudflared tunnel --url http://localhost:8000
start "MCP Server" cmd /k python C:\usr\mcp\local-access\server.py