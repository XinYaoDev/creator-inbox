#!/usr/bin/env python3
"""LAN image-gen bridge: Creator Inbox notes → Hermes image_generate.

Mac-only sidecar. Does not expose the Hermes gateway. Auth is a bearer token
from ~/.hermes/image-bridge.env (chmod 600). ChatGPT OAuth stays in Hermes.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERMES_AGENT = Path(os.environ.get("HERMES_AGENT_HOME") or Path.home() / ".hermes" / "hermes-agent")
ENV_FILE = Path.home() / ".hermes" / "image-bridge.env"
HOST = os.environ.get("HERMES_IMAGE_HOST") or "0.0.0.0"
PORT = int(os.environ.get("HERMES_IMAGE_PORT") or "8879")
MAX_PROMPT = 4000
EMPTY_RETRY = 1
MAX_GENERATE_BODY = 12_000_000
MAX_XHS_BODY = 64_000
WEBBRIDGE = os.environ.get("WEBBRIDGE_URL") or "http://127.0.0.1:10086/command"
XHS_SESSION = "xhs-asset-learn"
XHS_EXTRACT = r"""
(() => {
  function unwrap(v, d) {
    if (v == null || d > 8) return v;
    if (typeof v === 'object') {
      if ('__v_isRef' in v) return unwrap(v._value !== undefined ? v._value : v.value, d + 1);
      if ('_value' in v && Object.keys(v).filter(k => !k.startsWith('_') && !k.startsWith('__')).length <= 1)
        return unwrap(v._value, d + 1);
    }
    return v;
  }
  function prim(obj, path) {
    try {
      let x = obj;
      for (const p of path.split('.')) x = unwrap(x && x[p]);
      if (x && typeof x === 'object' && 'value' in x) x = unwrap(x.value);
      return x == null ? '' : x;
    } catch (e) { return ''; }
  }
  const root = unwrap(window.__INITIAL_STATE__);
  const noteRoot = unwrap(root && root.note);
  const map = unwrap(noteRoot && noteRoot.noteDetailMap);
  if (!map || typeof map !== 'object') return { ok: false, error: 'no noteDetailMap' };
  const id = Object.keys(map)[0];
  const rec = unwrap(map[id]);
  const nd = unwrap(rec && rec.note) || rec || {};
  const title = String(prim(nd, 'title') || prim(nd, 'displayTitle') || '');
  const desc = String(prim(nd, 'desc') || prim(nd, 'description') || '');
  return {
    ok: Boolean(title || desc),
    note: {
      id: String(id || prim(noteRoot, 'currentNoteId') || ''),
      title,
      desc,
      nick: String(prim(nd, 'user.nickname') || prim(nd, 'user.nickName') || ''),
      liked: String(prim(nd, 'interactInfo.likedCount') || ''),
      collected: String(prim(nd, 'interactInfo.collectedCount') || ''),
      comment: String(prim(nd, 'interactInfo.commentCount') || ''),
      share: String(prim(nd, 'interactInfo.shareCount') || ''),
      time: Number(prim(nd, 'time') || prim(nd, 'lastUpdateTime') || 0) || 0,
      ip: String(prim(nd, 'ipLocation') || ''),
    },
  };
})()
"""
_xhs_opened = False


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if not t or t.startswith("#") or "=" not in t:
            continue
        k, v = t.split("=", 1)
        k, v = k.strip(), v.strip().strip("'").strip('"')
        if k and k not in os.environ:
            os.environ[k] = v


def token() -> str:
    return (os.environ.get("HERMES_IMAGE_TOKEN") or "").strip()


def setup_hermes() -> None:
    if not HERMES_AGENT.is_dir():
        raise SystemExit(f"Hermes agent not found: {HERMES_AGENT}")
    os.chdir(HERMES_AGENT)
    sys.path.insert(0, str(HERMES_AGENT))


def generate_once(prompt: str, aspect: str, image_path: str | None = None) -> dict:
    from tools.image_generation_tool import _handle_image_generate

    args: dict = {"prompt": prompt, "aspect_ratio": aspect}
    if image_path:
        args["image_url"] = image_path
    raw = _handle_image_generate(args)
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"success": False, "error": raw[:300]}
    if isinstance(raw, dict):
        return raw
    return {"success": False, "error": "unexpected image_generate result"}


def generate(prompt: str, aspect: str, image_bytes: bytes | None = None) -> bytes:
    tmp = None
    if image_bytes:
        fd, name = tempfile.mkstemp(prefix="hermes-ref-", suffix=".jpg")
        os.close(fd)
        tmp = Path(name)
        tmp.write_bytes(image_bytes)
    last = "Hermes 出图失败"
    try:
        return _generate_loop(prompt, aspect, str(tmp) if tmp else None, last)
    finally:
        if tmp:
            try:
                tmp.unlink()
            except OSError:
                pass


def _generate_loop(prompt: str, aspect: str, image_path: str | None, last: str) -> bytes:
    for attempt in range(1 + EMPTY_RETRY):
        t0 = time.time()
        result = generate_once(prompt, aspect, image_path)
        dt = time.time() - t0
        if result.get("success") and result.get("image"):
            path = Path(str(result["image"]))
            if not path.is_file():
                last = f"Hermes 返回了路径但文件不存在: {path}"
                print(f"[hermes-image] miss file {dt:.1f}s attempt={attempt}", flush=True)
                continue
            data = path.read_bytes()
            if len(data) < 800:
                last = "出图结果太小，不像一张图"
                continue
            print(f"[hermes-image] ok {dt:.1f}s {len(data)}b attempt={attempt}", flush=True)
            return data
        err = str(result.get("error") or "empty_response")
        kind = str(result.get("error_type") or "")
        last = err
        print(f"[hermes-image] fail {dt:.1f}s attempt={attempt} {kind} {err[:120]}", flush=True)
        if kind not in ("empty_response", "") and "empty" not in err.lower():
            break
    raise RuntimeError(last)


def authorized(handler: BaseHTTPRequestHandler) -> bool:
    got = handler.headers.get("Authorization") or ""
    expect = f"Bearer {token()}"
    return bool(token()) and got == expect


def wb_command(action: str, args: dict, timeout: int = 40) -> dict:
    payload = json.dumps({"action": action, "args": args, "session": XHS_SESSION}, ensure_ascii=False).encode("utf-8")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        WEBBRIDGE,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with opener.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"WebBridge HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"WebBridge 连不上: {e.reason}") from e


def parse_eval(ev: dict) -> dict | None:
    if not isinstance(ev, dict):
        return None
    val = ev.get("value")
    if isinstance(val, str):
        try:
            val = json.loads(val)
        except json.JSONDecodeError:
            return None
    if isinstance(val, dict) and (val.get("note") or val.get("ok")):
        return val
    return None


def fetch_xhs_note(url: str) -> dict:
    global _xhs_opened
    args_reuse = {"url": url, "newTab": False}
    args_first = {"url": url, "newTab": True, "group_title": "资产学习"}
    if _xhs_opened:
        nav = wb_command("navigate", args_reuse)
        if not (nav.get("success") or nav.get("url") or nav.get("tabId")):
            nav = wb_command("navigate", args_first)
    else:
        nav = wb_command("navigate", args_first)
        if not (nav.get("success") or nav.get("url") or nav.get("tabId")):
            nav = wb_command("navigate", args_reuse)
    if not (nav.get("success") or nav.get("url") or nav.get("tabId")):
        raise RuntimeError(nav.get("error") or "WebBridge 打开小红书失败")
    _xhs_opened = True
    last = "页面还没加载出笔记"
    for _ in range(5):
        ev = wb_command("evaluate", {"code": XHS_EXTRACT}, timeout=20)
        parsed = parse_eval(ev)
        if parsed and parsed.get("ok") and parsed.get("note"):
            note = parsed["note"]
            if note.get("title") or note.get("desc"):
                return note
        if isinstance(ev, dict):
            last = str(ev.get("error") or (parsed or {}).get("error") or last)
        time.sleep(2)
    raise RuntimeError(last)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path != "/health":
            return self._json(404, {"ok": False, "error": "not found"})
        if not authorized(self):
            return self._json(401, {"ok": False, "error": "unauthorized"})
        try:
            from tools.image_generation_tool import check_image_generation_requirements

            ok = bool(check_image_generation_requirements())
        except Exception as e:
            return self._json(503, {"ok": False, "error": str(e)})
        return self._json(200 if ok else 503, {"ok": ok, "image": "hermes"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/generate", "/xhs-note"):
            return self._json(404, {"ok": False, "error": "not found"})
        if not authorized(self):
            return self._json(401, {"ok": False, "error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        limit = MAX_XHS_BODY if path == "/xhs-note" else MAX_GENERATE_BODY
        if n <= 0 or n > limit:
            return self._json(400, {"ok": False, "error": "bad body"})
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self._json(400, {"ok": False, "error": "json required"})
        if path == "/xhs-note":
            url = str((body or {}).get("url") or "").strip()
            host = (urlparse(url).hostname or "").lower()
            if not url or "xiaohongshu.com" not in host:
                return self._json(400, {"ok": False, "error": "要一条小红书笔记链接"})
            try:
                note = fetch_xhs_note(url)
            except Exception as e:
                return self._json(502, {"ok": False, "error": str(e)})
            return self._json(200, {"ok": True, "note": note})
        prompt = str((body or {}).get("prompt") or "").strip()
        aspect = str((body or {}).get("aspect_ratio") or "portrait").strip() or "portrait"
        if not prompt:
            return self._json(400, {"ok": False, "error": "prompt required"})
        if len(prompt) > MAX_PROMPT:
            return self._json(400, {"ok": False, "error": "prompt too long"})
        raw_image = str((body or {}).get("image") or "").strip()
        image_bytes = None
        if raw_image:
            if raw_image.startswith("data:") and "," in raw_image:
                raw_image = raw_image.split(",", 1)[1]
            try:
                image_bytes = base64.b64decode(raw_image, validate=False)
            except Exception:
                return self._json(400, {"ok": False, "error": "底图读不出来"})
            if len(image_bytes) < 80:
                return self._json(400, {"ok": False, "error": "底图太小"})
        try:
            data = generate(prompt, aspect, image_bytes)
        except Exception as e:
            return self._json(502, {"ok": False, "error": str(e)})
        ctype = "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    load_env_file(ENV_FILE)
    if not token():
        raise SystemExit(f"Set HERMES_IMAGE_TOKEN or write it to {ENV_FILE}")
    setup_hermes()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[hermes-image] listening {HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
