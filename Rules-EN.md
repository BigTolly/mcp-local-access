# Rules

## What this project is

- A local MCP server: it gives external AI services (Notion AI, claude.ai, ChatGpt and others)
  controlled access to a single folder on your PC.
  The MCP server is the "hands", the AI model of the service is the "brain".
- Stack: Python + MCP SDK (FastMCP) + uvicorn, Streamable HTTP transport on `/mcp`,
  Bearer-token authorization, exposed to the outside through a `cloudflared` tunnel or a web server with TLS.
- Project details are in `README.md`.
- The source of truth for the actual behaviour is `server.py`.
  If the README and the code disagree, the code is right and the README must be fixed.

## How to work in this project

- First `list_files` / `search_text`, then `read_file`, and only after that the edits.
- Make the edits in the files yourself instead of sending code into the chat.
- Targeted edits — `edit_file`; several replacements in one file — in a single
  `multi_edit`; renaming — `move`. A full rewrite (`create` with
  `overwrite=true`) — only when the file is really being rewritten as a whole.
- Do not edit one file with parallel calls: each of them reads and writes it as a whole,
  simultaneous calls overwrite each other.
- If you change the server's behaviour → in the same pass sync `README.md` and, if
  needed, `config.example.json`.
- Check the path before `delete`: there is no trash, deletion is permanent.

## What not to do

- Do not work around `Permission denied` — it is a final answer, not an obstacle.
- Do not try to widen your own permissions: `config.json` is closed by the
  `*(**/config.json)` rule on purpose, only the owner changes the permissions.
- Do not touch the secrets: `**/.env`, `**/.env.*`, `**/secrets/**`, `*.pem`, `*.key`.
  Do not publish or commit the token from `.env`.
