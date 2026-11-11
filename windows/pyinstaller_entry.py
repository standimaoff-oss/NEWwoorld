"""Standalone PyInstaller entry point launching NEWwoorld Studio in a desktop window."""

from __future__ import annotations
import socket
import threading
import time
import webbrowser
import uvicorn


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def main() -> None:
    port = _find_free_port()
    url = f"http://127.0.0.1:{port}/"

    def run_srv():
        uvicorn.run("newwoorld_ai.server:app", host="127.0.0.1", port=port, log_level="warning")

    t = threading.Thread(target=run_srv, daemon=True)
    t.start()
    time.sleep(1.5)

    try:
        import webview  # type: ignore
        webview.create_window("NEWwoorld AI Studio", url, width=1440, height=900)
        webview.start()
    except Exception:
        webbrowser.open(url)
        try:
            while t.is_alive():
                time.sleep(1.0)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
