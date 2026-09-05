"""Small local HTTP bridge for the F5-TTS provider used by AI Virtual Phone.

Run from the F5-TTS Python environment:
    python scripts/f5-tts-server.py

The browser calls POST http://127.0.0.1:7861/tts with JSON containing
text/ref_audio/ref_text and receives a WAV response.
"""
from pathlib import Path
import tempfile
import threading

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from f5_tts.api import F5TTS

f5tts = None
inference_lock = threading.Lock()


def get_model(model_name: str):
    global f5tts
    if f5tts is None:
        f5tts = F5TTS(model=model_name, device="cpu")
    return f5tts


def make_audio(data):
    text = str(data.get("text", "")).strip()
    ref_audio = str(data.get("ref_audio", "")).strip()
    ref_text = str(data.get("ref_text", ""))
    model = str(data.get("model", "F5TTS_v1_Base"))
    if not text:
        raise ValueError("text is required")
    if not ref_audio:
        raise ValueError("ref_audio is required")
    ref_path = Path(ref_audio).expanduser()
    if not ref_path.is_file():
        raise ValueError(f"reference audio not found: {ref_audio}")
    engine = get_model(model)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        # F5-TTS inference is CPU-heavy; keep model inference single-file at a time.
        with inference_lock:
            engine.infer(
                ref_file=str(ref_path),
                ref_text=ref_text,
                gen_text=text,
                nfe_step=int(data.get("nfe_step", 32)),
                speed=float(data.get("speed", 1.0)),
                remove_silence=bool(data.get("remove_silence", False)),
                file_wave=out_path,
            )
        return Path(out_path).read_bytes()
    finally:
        try:
            Path(out_path).unlink(missing_ok=True)
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    def _headers(self, status=200, content_type="application/json", length=None):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def do_OPTIONS(self):
        self._headers(204, length=0)

    def do_GET(self):
        if self.path == "/health":
            payload = json.dumps({"ok": True, "service": "f5-tts", "loaded": f5tts is not None}).encode()
            self._headers(200, length=len(payload))
            self.wfile.write(payload)
            return
        self._headers(404, length=0)

    def do_POST(self):
        if self.path not in ("/tts", "/v1/audio/speech"):
            self._headers(404, length=0)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(size).decode("utf-8"))
            # /v1/audio/speech accepts the OpenAI-shaped body so the bridge can
            # also be used by existing OpenAI-compatible callers if needed.
            if self.path == "/v1/audio/speech":
                data = {**data, "text": data.get("input", "")}
            audio = make_audio(data)
            self._headers(200, "audio/wav", len(audio))
            self.wfile.write(audio)
        except Exception as exc:
            payload = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
            self._headers(500, length=len(payload))
            self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(f"[F5-TTS] {self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    print("F5-TTS bridge listening on http://127.0.0.1:7861")
    ThreadingHTTPServer(("127.0.0.1", 7861), Handler).serve_forever()
