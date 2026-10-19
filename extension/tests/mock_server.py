"""Minimal stand-in for server.py's BrowserBridge, driven over stdin/stdout.

Used by tests/bridge.test.mjs. Binds 127.0.0.1 only.
  stdin  : JSON lines {"send": {...}} | {"close": true} | {"quit": true}
  stdout : JSON lines {"event": "listening"|"connected"|"disconnected"|"message", "data": ...}
"""
import asyncio
import json
import sys
import threading

try:
    from websockets.asyncio.server import serve
except ImportError:  # older websockets
    from websockets import serve

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19009
state = {"ws": None}


def emit(event, data=None):
    print(json.dumps({"event": event, "data": data}), flush=True)


async def handler(ws, *_):
    previous, state["ws"] = state["ws"], ws
    if previous is not None:
        await previous.close()
    emit("connected")
    try:
        async for raw in ws:
            try:
                emit("message", json.loads(raw))
            except ValueError:
                emit("message", {"raw": str(raw)})
    except Exception:
        pass
    finally:
        if state["ws"] is ws:
            state["ws"] = None
        emit("disconnected")


async def command(cmd):
    ws = state["ws"]
    if "send" in cmd and ws is not None:
        await ws.send(json.dumps(cmd["send"]))
    elif cmd.get("close") and ws is not None:
        await ws.close()
    elif cmd.get("quit"):
        asyncio.get_running_loop().stop()


async def main():
    loop = asyncio.get_running_loop()

    def read_stdin():
        for line in sys.stdin:
            line = line.strip()
            if line:
                asyncio.run_coroutine_threadsafe(command(json.loads(line)), loop)
        loop.call_soon_threadsafe(loop.stop)

    threading.Thread(target=read_stdin, daemon=True).start()
    await serve(handler, "127.0.0.1", PORT)
    emit("listening", PORT)
    await asyncio.Event().wait()


try:
    asyncio.run(main())
except RuntimeError:
    pass  # loop stopped by quit
