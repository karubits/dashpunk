"""Spotify Web API integration for the like button — stdlib only.

OAuth 2.0 Authorization Code + PKCE: the user creates a (free) app on
developer.spotify.com with redirect URI http://127.0.0.1:8898/callback and
puts its Client ID in config.toml. Linking opens the browser once; a one-shot
loopback HTTP listener catches the redirect. Tokens are cached on disk and
refreshed automatically — no client secret involved.
"""

import base64
import hashlib
import json
import os
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
import time

from http.server import BaseHTTPRequestHandler, HTTPServer

from .config import CONFIG_DIR

TOKEN_PATH = os.path.join(CONFIG_DIR, "spotify_token.json")
AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API = "https://api.spotify.com/v1"
REDIRECT_PORT = 8898
REDIRECT_URI = f"http://127.0.0.1:{REDIRECT_PORT}/callback"
SCOPES = "user-library-read user-library-modify"
TIMEOUT = 5
LIKED_CACHE_MAX = 64

AUTH_DONE_HTML = (b"<html><body style='background:#04060c;color:#00f0ff;"
                  b"font-family:monospace;text-align:center;padding-top:20vh'>"
                  b"<h1>DASHPUNK // SPOTIFY LINKED</h1>"
                  b"<p>You can close this tab.</p></body></html>")


class SpotifyClient:
    def __init__(self, cfg):
        self.client_id = (cfg or {}).get("client_id", "")
        self._lock = threading.Lock()
        self._tokens = self._load_tokens()
        self._liked = {}        # track_id -> bool
        self._fetching = set()  # track_ids with an in-flight liked lookup
        self._auth_running = False

    @property
    def status(self):
        if not self.client_id:
            return "off"
        return "on" if self._tokens.get("refresh_token") else "unlinked"

    # -- liked state -----------------------------------------------------------

    def is_liked(self, track_id):
        """Cached liked state, or None while unknown (fetch happens async so
        the collector tick never blocks on the network)."""
        if self.status != "on" or not track_id:
            return None
        with self._lock:
            if track_id in self._liked:
                return self._liked[track_id]
            if track_id in self._fetching:
                return None
            self._fetching.add(track_id)
        threading.Thread(target=self._fetch_liked, args=(track_id,), daemon=True).start()
        return None

    def _fetch_liked(self, track_id):
        res = self._request("GET", "/me/tracks/contains", {"ids": track_id})
        with self._lock:
            self._fetching.discard(track_id)
            if isinstance(res, list) and res:
                self._cache_liked(track_id, bool(res[0]))

    def toggle_like(self, track_id, liked):
        if self.status != "on" or not track_id:
            return
        with self._lock:  # optimistic — next state push shows it immediately
            self._cache_liked(track_id, liked)
        method = "PUT" if liked else "DELETE"
        if self._request(method, "/me/tracks", {"ids": track_id}) is None:
            with self._lock:
                self._liked.pop(track_id, None)  # failed — refetch next tick

    def _cache_liked(self, track_id, liked):
        self._liked[track_id] = liked
        while len(self._liked) > LIKED_CACHE_MAX:
            self._liked.pop(next(iter(self._liked)))

    # -- OAuth PKCE ------------------------------------------------------------

    def start_auth(self):
        """Interactive one-time link: browser consent + loopback redirect."""
        if not self.client_id:
            return
        with self._lock:
            if self._auth_running:
                return
            self._auth_running = True
        try:
            self._run_auth()
        except Exception as e:  # never take the dashboard down over auth
            print(f"[spotify] auth failed: {type(e).__name__}: {e}")
        finally:
            with self._lock:
                self._auth_running = False

    def _run_auth(self):
        verifier = secrets.token_urlsafe(64)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(16)
        url = AUTH_URL + "?" + urllib.parse.urlencode({
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "state": state,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
        })

        result = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                if q.get("state", [""])[0] == state and "code" in q:
                    result["code"] = q["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(AUTH_DONE_HTML)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", REDIRECT_PORT), Handler)
        server.timeout = 5
        try:
            self._open_browser(url)
            deadline = time.monotonic() + 180
            while "code" not in result and time.monotonic() < deadline:
                server.handle_request()
        finally:
            server.server_close()

        if "code" not in result:
            print("[spotify] auth timed out / was denied")
            return
        tokens = self._token_request({
            "grant_type": "authorization_code",
            "code": result["code"],
            "redirect_uri": REDIRECT_URI,
            "client_id": self.client_id,
            "code_verifier": verifier,
        })
        if tokens:
            print("[spotify] linked")

    @staticmethod
    def _open_browser(url):
        try:
            from gi.repository import Gio
            Gio.AppInfo.launch_default_for_uri(url, None)
        except Exception as e:
            print(f"[spotify] open {url} manually ({e})")

    # -- token plumbing ----------------------------------------------------------

    def _load_tokens(self):
        try:
            with open(TOKEN_PATH) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _save_tokens(self, tokens):
        self._tokens = tokens
        try:
            os.makedirs(CONFIG_DIR, exist_ok=True)
            fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(tokens, f)
        except OSError as e:
            print(f"[spotify] could not save token: {e}")

    def _token_request(self, form):
        try:
            req = urllib.request.Request(
                TOKEN_URL, data=urllib.parse.urlencode(form).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = json.load(resp)
        except (urllib.error.URLError, ValueError, OSError) as e:
            print(f"[spotify] token request failed: {e}")
            return None
        tokens = dict(self._tokens)
        tokens["access_token"] = data["access_token"]
        tokens["expires_at"] = time.time() + data.get("expires_in", 3600) - 60
        if data.get("refresh_token"):
            tokens["refresh_token"] = data["refresh_token"]
        self._save_tokens(tokens)
        return tokens

    def _access_token(self, force_refresh=False):
        t = self._tokens
        if not t.get("refresh_token"):
            return None
        if force_refresh or not t.get("access_token") or time.time() >= t.get("expires_at", 0):
            t = self._token_request({
                "grant_type": "refresh_token",
                "refresh_token": t["refresh_token"],
                "client_id": self.client_id,
            })
        return t.get("access_token") if t else None

    def _request(self, method, path, params):
        """API call; returns parsed JSON (or True for empty 2xx), None on error."""
        token = self._access_token()
        if not token:
            return None
        url = API + path + "?" + urllib.parse.urlencode(params)
        for attempt in (0, 1):
            try:
                req = urllib.request.Request(
                    url, method=method,
                    headers={"Authorization": f"Bearer {token}",
                             "Content-Length": "0"} if method in ("PUT", "DELETE")
                    else {"Authorization": f"Bearer {token}"},
                    data=b"" if method in ("PUT", "DELETE") else None,
                )
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    body = resp.read()
                    return json.loads(body) if body.strip() else True
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    token = self._access_token(force_refresh=True)
                    if token:
                        continue
                print(f"[spotify] {method} {path}: HTTP {e.code}")
                return None
            except (urllib.error.URLError, ValueError, OSError) as e:
                print(f"[spotify] {method} {path}: {e}")
                return None
        return None
