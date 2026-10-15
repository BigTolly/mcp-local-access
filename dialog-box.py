"""Local Access desktop input tool; no extra dependencies.

Tk runs on the main thread of a child process, never on the HTTP event loop.
A timed-out/cancelled MCP call can resume waiting for that same window.
"""
from __future__ import annotations

import asyncio
import atexit
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import struct
import wave
import tkinter as tk

_SESSION_LOCK = threading.Lock()
_process = None
_temp_dir = None

def load_settings(config=None):
    """Validate the dialog section of the server's existing config.json.

    No second configuration file. Zero/null disables only our per-call wait
    deadline, not client/proxy timeouts. The window itself never expires.
    """
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("config.json: dialog must be an object")
    timeout = config.get("waitTimeoutSeconds", 600)
    if timeout is not None:
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout < 0:
            raise ValueError("dialog.waitTimeoutSeconds must be non-negative or null")
        timeout = float(timeout) or None
    width, height = config.get("width", 500), config.get("height", 300)
    if type(width) is not int or type(height) is not int or width < 320 or height < 240:
        raise ValueError("dialog.width/height must be integers, at least 320x240")
    sound = config.get("sound", False)
    if not isinstance(sound, bool):
        raise ValueError("dialog.sound must be true or false")
    auto_prompt = config.get("autoPrompt", True)
    if not isinstance(auto_prompt, bool):
        raise ValueError("dialog.autoPrompt must be true or false")
    return dict(timeout=timeout, interval=0.2,
                width=width, height=height, sound=sound, autoPrompt=auto_prompt)


def notification_wave():
    """A short PCM chime, independent of the Windows sound-event scheme."""
    rate, duration = 22050, 0.24
    frames = bytearray()
    for i in range(int(rate * duration)):
        t = i / rate
        envelope = math.sin(math.pi * t / duration) ** 2
        sample = int(6500 * envelope * (math.sin(2 * math.pi * 880 * t)
                                       + 0.35 * math.sin(2 * math.pi * 1320 * t)))
        frames.extend(struct.pack("<h", sample))
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(frames)
    return output.getvalue()


def notify(root, enabled, warnings=None):
    """Play once on opening, never on retry or resize. Return the audio thread."""
    if not enabled:
        return None

    def play():
        try:
            import winsound
            # SND_MEMORY does not support asynchronous playback, so use a thread.
            winsound.PlaySound(notification_wave(), winsound.SND_MEMORY | winsound.SND_NODEFAULT)
        except (OSError, RuntimeError) as exc:
            if warnings is not None:
                warnings.append(f"Notification sound unavailable: {exc}")

    if sys.platform == "win32":
        thread = threading.Thread(target=play, daemon=True)
        thread.start()
        return thread
    try:
        root.bell()
    except tk.TclError as exc:
        if warnings is not None:
            warnings.append(f"Notification sound unavailable: {exc}")
    return None


def dock_bounds(monitor):
    """Full monitor height, rightmost third (not the taskbar work area)."""
    left, top, right, bottom = monitor
    width = max(1, (right - left) // 3)
    return width, bottom - top, right - width, top


def monitor_bounds(root):
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class MonitorInfo(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                        ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

        user32 = ctypes.windll.user32
        user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        user32.MonitorFromWindow.restype = wintypes.HANDLE
        user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
        user32.GetMonitorInfoW.restype = wintypes.BOOL
        info = MonitorInfo()
        info.cbSize = ctypes.sizeof(info)
        handle = user32.MonitorFromWindow(root.winfo_id(), 2)
        if user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            rect = info.rcMonitor
            return rect.left, rect.top, rect.right, rect.bottom
    return (root.winfo_vrootx(), root.winfo_vrooty(),
            root.winfo_vrootx() + root.winfo_vrootwidth(),
            root.winfo_vrooty() + root.winfo_vrootheight())


def set_bounds(root, bounds):
    width, height, x, y = bounds
    root.geometry(f"{width}x{height}{x:+d}{y:+d}")
    root.update_idletasks()
    if sys.platform == "win32":
        # Tk interprets negative geometry offsets relative to the right/bottom.
        # Use absolute desktop coordinates for monitors left/above the primary.
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                       ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user32.SetWindowPos.restype = wintypes.BOOL
        hwnd = user32.GetAncestor(root.winfo_id(), 2)
        if not user32.SetWindowPos(hwnd, None, x, y, width, height, 0x0014):
            raise OSError("Cannot position dialog window")


# Tiny PNGs are embedded: no external icon files or SVG runtime dependencies.
ICONS = {
    "expand": "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAVklEQVRIiWNgGDZg3759h/fv3/8fHe/bt+8wVfRgU0iuBSCM0wKKgoEBjzmjFhAMCVCE4YtQYgG1zBkFowALoHky3T9aFg2a0nQ/rSqcfbSuMhmGKgAAqlUxpFQWTyMAAAAASUVORK5CYII=",
    "collapse": "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAACXBIWXMAAAsTAAALEwEAmpwYAAAAVUlEQVRIiWNgGNZg3759h0GYXHmCYP/+/f9BmFz5UQsYSAoiUGTBNKBjBgJxgI6xRjwuC/YRSEWk6hkFo4ACQPNkuo/WGQ0bGC1NBz6I9tG6yhwSAACqVTGk+loQegAAAABJRU5ErkJggg==",
}
BG = "#191919"
FIELD = "#232323"
BORDER = "#747474"
FG = "#f5f5f5"
MUTED = "#b3b3b3"
ACCENT = "#5e9fe8"
FONT = ("Segoe UI", -18)  # Negative Tk sizes are pixels, not points.


def round_rect(canvas, x1, y1, x2, y2, radius=8, **options):
    radius = min(radius, (x2 - x1) / 2, (y2 - y1) / 2)
    return canvas.create_polygon(
        x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius,
        x2, y2 - radius, x2, y2, x2 - radius, y2, x1 + radius, y2,
        x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1,
        smooth=True, splinesteps=24, **options)


def round_window(root, radius=12):
    """Clip the actual native Windows window, not just its painted background."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes
    size = (root.winfo_width(), root.winfo_height())
    if size == getattr(root, "_rounded_size", None):
        return
    user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
    user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetAncestor.restype = wintypes.HWND
    gdi32.CreateRoundRectRgn.argtypes = [ctypes.c_int] * 6
    gdi32.CreateRoundRectRgn.restype = wintypes.HANDLE
    user32.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.BOOL]
    user32.SetWindowRgn.restype = ctypes.c_int
    gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi32.DeleteObject.restype = wintypes.BOOL
    region = gdi32.CreateRoundRectRgn(0, 0, size[0] + 1, size[1] + 1, radius * 2, radius * 2)
    if not region:
        raise OSError("Cannot create rounded window region")
    if not user32.SetWindowRgn(user32.GetAncestor(root.winfo_id(), 2), region, True):
        gdi32.DeleteObject(region)
        raise OSError("Cannot apply rounded window region")
    # Windows now owns the region handle.
    root._rounded_size = size


class RoundedButton(tk.Canvas):
    """Compact rounded control with a 44px hit area and keyboard focus."""
    def __init__(self, parent, command, text="", image=None, primary=False, width=72):
        super().__init__(parent, width=width, height=44, bg=BG, bd=0,
                         highlightthickness=0, takefocus=True, cursor="hand2")
        self.command, self.label, self.image = command, text, image
        self.primary, self.hovered, self.pressed = primary, False, False
        self.bind("<Configure>", lambda event: self.paint())
        self.bind("<Enter>", lambda event: self.hover(True))
        self.bind("<Leave>", lambda event: self.hover(False))
        self.bind("<FocusIn>", lambda event: self.paint())
        self.bind("<FocusOut>", lambda event: self.paint())
        self.bind("<ButtonPress-1>", self.press)
        self.bind("<ButtonRelease-1>", self.release)
        self.bind("<space>", self.keyboard)
        self.bind("<Return>", self.keyboard)

    def paint(self):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 2 or h < 2:
            return
        fill = ("#82b7f0" if self.hovered else ACCENT) if self.primary else ("#383838" if self.hovered else "#292929")
        if self.pressed:
            fill = "#4b8bd0" if self.primary else "#444444"
        focused = self.focus_get() == self
        # Icon controls have no visible button chrome; retain keyboard focus.
        if self.image is None or focused:
            round_rect(self, 1, 4, w - 1, h - 4,
                       fill="" if self.image is not None else fill,
                       outline=ACCENT if focused else fill if self.primary else "#929292" if self.hovered else BORDER,
                       width=2 if focused else 1)
        if self.image is not None:
            self.create_image(w / 2, h / 2, image=self.image)
        else:
            self.create_text(w / 2, h / 2, text=self.label, font=FONT,
                             fill="#111111" if self.primary else FG)

    def hover(self, active):
        self.hovered = active
        if not active:
            self.pressed = False
        self.paint()

    def press(self, event):
        if self.image is None:
            self.focus_set()
        self.pressed = True
        self.paint()

    def release(self, event):
        invoke = self.pressed and 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height()
        self.pressed = False
        self.paint()
        if invoke:
            self.invoke()

    def keyboard(self, event):
        self.invoke()
        return "break"

    def invoke(self):
        return self.command()

    def set_image(self, image):
        self.image = image
        self.paint()


class DialogWindow:
    def __init__(self, settings):
        self.tk = tk
        self.settings = settings
        self.result = None
        self.warnings = []
        self.sound_thread = None
        self.expanded = False
        self.compact_bounds = None
        self.tooltip = None
        self.drag_origin = None
        self.focus_after = None
        root = self.root = tk.Tk()
        root.withdraw()
        root.title("Ask me")
        root.overrideredirect(True)
        root.configure(bg=BG)
        root.attributes("-topmost", True)
        root.protocol("WM_DELETE_WINDOW", self.cancel)

        self.border = tk.Canvas(root, bg=BG, bd=0, highlightthickness=0)
        self.border.place(x=0, y=0, relwidth=1, relheight=1)
        self.border.bind("<Configure>", self.draw_border)
        content = tk.Frame(root, bg=BG, bd=0)
        content.pack(fill=tk.BOTH, expand=True, padx=12, pady=(4, 8))
        title = self.title_bar = tk.Frame(content, bg=BG, height=48)
        title.pack(fill=tk.X)
        title.pack_propagate(False)
        self.icons = {name: tk.PhotoImage(data=data) for name, data in ICONS.items()}
        self.toggle_button = RoundedButton(title, command=self.toggle_size,
                                           image=self.icons["expand"], width=44)
        self.toggle_button.pack(side=tk.RIGHT)
        self.toggle_button.bind("<Enter>", lambda event: self.show_tooltip(), add="+")
        self.toggle_button.bind("<Leave>", lambda event: self.hide_tooltip(), add="+")
        self.toggle_button.bind("<FocusIn>", lambda event: self.show_tooltip(), add="+")
        self.toggle_button.bind("<FocusOut>", lambda event: self.hide_tooltip(), add="+")
        self.title_label = tk.Label(title, text="Ask me", font=FONT,
                                    bg=BG, fg=FG, anchor="w", padx=4)
        self.title_label.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        for widget in (title, self.title_label):
            widget.bind("<Button-1>", self.start_move)
            widget.bind("<B1-Motion>", self.move)

        footer = tk.Frame(content, bg=BG)
        footer.pack(side=tk.BOTTOM, fill=tk.X, pady=(8, 0))
        self.paste_button = RoundedButton(footer, command=self.paste, text="Paste", width=70)
        self.paste_button.pack(side=tk.LEFT)
        self.ok_button = RoundedButton(footer, command=self.submit, text="OK", primary=True, width=60)
        self.ok_button.pack(side=tk.RIGHT)
        self.info = tk.Label(footer, text="Empty answer exits", font=FONT,
                             bg=BG, fg=MUTED)
        self.info.pack(fill=tk.BOTH, expand=True, padx=8)

        self.field = tk.Canvas(content, bg=BG, bd=0, highlightthickness=0)
        self.field.pack(fill=tk.BOTH, expand=True)
        self.text = tk.Text(self.field, height=4, width=1, font=FONT, wrap=tk.WORD,
                            bg=FIELD, fg=FG, insertbackground=FG, selectbackground="#345d88",
                            selectforeground="white", padx=4, pady=4, relief="flat", bd=0,
                            highlightthickness=0, undo=True)
        self.text_window = self.field.create_window(8, 8, window=self.text, anchor="nw")
        self.field.bind("<Configure>", self.draw_field)
        self.text.bind("<FocusIn>", lambda event: self.draw_field())
        self.text.bind("<FocusOut>", lambda event: self.draw_field())
        self.text.bind("<Control-Key>", self.control_key)
        self.text.bind("<Control-Return>", lambda event: self.submit())
        root.bind("<Escape>", lambda event: self.cancel())
        root.bind("<Configure>", self.configure)
        root.update_idletasks()
        left, top, right, bottom = monitor_bounds(root)
        width, height = min(settings["width"], right - left), min(settings["height"], bottom - top)
        set_bounds(root, (width, height, left + (right - left - width) // 2,
                          top + (bottom - top - height) // 2))
        root.deiconify()
        root.lift()
        self.focus_after = root.after(100, self.focus)

    def draw_border(self, event=None):
        w, h = self.border.winfo_width(), self.border.winfo_height()
        self.border.delete("all")
        if w < 26 or h < 26:
            return
        # True circular arcs follow the native 12px window radius. A smoothed
        # polygon bows outside that region and Windows clips its corner stroke.
        inset, radius = 1, 11
        left, top, right, bottom = inset, inset, w - inset, h - inset
        for coords in ((left + radius, top, right - radius, top),
                       (right, top + radius, right, bottom - radius),
                       (left + radius, bottom, right - radius, bottom),
                       (left, top + radius, left, bottom - radius)):
            self.border.create_line(*coords, fill=BORDER, width=1)
        diameter = radius * 2
        for box, start in (((left, top, left + diameter, top + diameter), 90),
                           ((right - diameter, top, right, top + diameter), 0),
                           ((right - diameter, bottom - diameter, right, bottom), 270),
                           ((left, bottom - diameter, left + diameter, bottom), 180)):
            self.border.create_arc(*box, start=start, extent=90,
                                   style=tk.ARC, outline=BORDER, width=1)

    def draw_field(self, event=None):
        w, h = self.field.winfo_width(), self.field.winfo_height()
        if w < 2 or h < 2:
            return
        self.field.delete("outline")
        item = round_rect(self.field, 1, 1, w - 1, h - 1, radius=10, fill=FIELD,
                          outline=ACCENT if self.root.focus_get() == self.text else BORDER, width=1)
        self.field.addtag_withtag("outline", item)
        self.field.tag_lower(item)
        self.field.itemconfigure(self.text_window, width=max(1, w - 16), height=max(1, h - 16))

    def configure(self, event):
        if event.widget == self.root:
            round_window(self.root)

    def focus(self):
        self.focus_after = None
        self.root.lift()
        self.text.focus_force()
        self.sound_thread = notify(self.root, self.settings.get("sound", False), self.warnings)

    def show_tooltip(self):
        if self.tooltip:
            return
        self.tooltip = tk.Toplevel(self.root)
        self.tooltip.overrideredirect(True)
        self.tooltip.attributes("-topmost", True)
        tk.Label(self.tooltip, text="Collapse" if self.expanded else "Expand",
                 bg="#383838", fg=FG, font=FONT, padx=8, pady=4).pack()
        self.tooltip.update_idletasks()
        x = self.toggle_button.winfo_rootx() + self.toggle_button.winfo_width() - self.tooltip.winfo_reqwidth()
        y = self.toggle_button.winfo_rooty() + self.toggle_button.winfo_height()
        set_bounds(self.tooltip, (self.tooltip.winfo_reqwidth(), self.tooltip.winfo_reqheight(), x, y))

    def hide_tooltip(self):
        if self.tooltip:
            self.tooltip.destroy()
            self.tooltip = None

    def toggle_size(self):
        self.hide_tooltip()
        self.root.update_idletasks()
        if self.expanded:
            set_bounds(self.root, self.compact_bounds)
        else:
            self.compact_bounds = (self.root.winfo_width(), self.root.winfo_height(),
                                   self.root.winfo_x(), self.root.winfo_y())
            set_bounds(self.root, dock_bounds(monitor_bounds(self.root)))
        self.expanded = not self.expanded
        self.toggle_button.set_image(self.icons["collapse" if self.expanded else "expand"])
        self.text.focus_set()

    def start_move(self, event):
        self.drag_origin = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())

    def move(self, event):
        if self.expanded or self.drag_origin is None:
            return
        x0, y0, x, y = self.drag_origin
        set_bounds(self.root, (self.root.winfo_width(), self.root.winfo_height(),
                              x + event.x_root - x0, y + event.y_root - y0))

    def paste(self):
        try:
            self.text.insert(tk.INSERT, self.root.clipboard_get())
        except tk.TclError:
            pass

    def control_key(self, event):
        # Physical V works independently of the Windows keyboard layout.
        if event.keysym.lower() == "v" or (sys.platform == "win32" and event.keycode == 86):
            self.paste()
            return "break"

    def close(self):
        self.hide_tooltip()
        if self.focus_after is not None:
            self.root.after_cancel(self.focus_after)
            self.focus_after = None
        self.root.destroy()

    def submit(self):
        self.result = self.text.get("1.0", "end-1c").strip()
        self.close()

    def cancel(self):
        self.result = None
        self.close()

    def run(self):
        self.root.mainloop()
        # Playback is short; capture any driver error before serializing warnings.
        if self.sound_thread:
            self.sound_thread.join(timeout=0.5)
        return self.result


def _discard_session():
    global _process, _temp_dir
    _process = None
    if _temp_dir is not None:
        _temp_dir.cleanup()
        _temp_dir = None


def close_dialog():
    """Stop only this server's GUI child, including on server exit."""
    if _process is not None and _process.poll() is None:
        _process.terminate()
        try:
            _process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            _process.kill()
            _process.wait(timeout=2)
    _discard_session()


atexit.register(close_dialog)


async def wait_for_dialog(config=None):
    global _process, _temp_dir
    settings = load_settings(config)
    if not _SESSION_LOCK.acquire(blocking=False):
        return "show-dialog-box is already waiting for a response; no second window was opened."
    try:
        if _process is None:
            _temp_dir = tempfile.TemporaryDirectory(prefix="local-access-dialog-")
            request = Path(_temp_dir.name) / "settings.json"
            try:
                request.write_text(json.dumps(settings), encoding="utf-8")
                _process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), str(request)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except OSError:
                _discard_session()
                raise
        deadline = time.monotonic() + settings["timeout"] if settings["timeout"] is not None else None
        while True:
            if _process.poll() is not None:
                result_path = Path(_temp_dir.name) / "result.json"
                try:
                    if not result_path.exists():
                        raise RuntimeError(f"Dialog process exited without a result (code {_process.returncode}). Check the desktop session and Tkinter installation.")
                    result = json.loads(result_path.read_text(encoding="utf-8"))
                    if "error" in result:
                        raise RuntimeError(f"Cannot show dialog: {result['error']}")
                    message = result.get("message")
                    if message is not None and not isinstance(message, str):
                        raise RuntimeError("Invalid dialog response")
                    warning = "".join(f"\nWarning: {item}" for item in result.get("warnings", []))
                    if not message:
                        return "Dialog finished." + warning
                    follow_up = ("\n\nAfter answering, call show-dialog-box again for the next question."
                                 if settings.get("autoPrompt", True) else "")
                    return f"USER QUESTION: {message}" + follow_up + warning
                finally:
                    _discard_session()
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return "Call show-dialog-box again to continue waiting for the same window."
                await asyncio.sleep(min(settings["interval"], remaining))
            else:
                await asyncio.sleep(settings["interval"])
    finally:
        _SESSION_LOCK.release()


def worker(request_path):
    request = Path(request_path)
    try:
        if sys.platform == "win32":
            import ctypes
            try:
                ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
            except AttributeError:
                ctypes.windll.user32.SetProcessDPIAware()
        settings = json.loads(request.read_text(encoding="utf-8"))
        window = DialogWindow(settings)
        result = {"message": window.run(), "warnings": window.warnings}
    except Exception as exc:
        result = {"error": f"{type(exc).__name__}: {exc}"}
    pending = request.with_name("result.tmp")
    pending.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    os.replace(pending, request.with_name("result.json"))


if __name__ == "__main__":
    worker(sys.argv[1])
