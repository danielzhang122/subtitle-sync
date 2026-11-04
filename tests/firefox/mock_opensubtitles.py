"""Stand-in for the OpenSubtitles REST API, for end-to-end tests.

    python mock_opensubtitles.py <port> <dir with good.srt and long.srt>

Checks the same things the real API requires (Api-Key, a named User-Agent) plus our own rule of
sending parameters sorted, and counts downloads so tests can confirm caching works.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

PORT = int(sys.argv[1])
FILES = Path(sys.argv[2])
KEY = "test-key"
downloads = {}
problems = []


def sub(file_id, title, season, episode, release, dl, tmdb=None):
    return {"id": str(file_id), "type": "subtitle", "attributes": {
        "language": "en", "download_count": dl, "hearing_impaired": False, "from_trusted": False,
        "machine_translated": False, "ai_translated": False, "release": release, "fps": 23.976,
        "feature_details": {"feature_type": "Episode", "parent_title": title, "title": "An Episode",
                            "season_number": season, "episode_number": episode, "year": 2024, "parent_tmdb_id": tmdb},
        "files": [{"file_id": file_id, "file_name": f"{release}.srt"}]}}


CATALOG = {
    ("test show", "1", "2"): [
        sub(101, "Test Show", 1, 3, "Test.Show.S01E03.WEB", 9000),            # wrong episode: must be filtered
        sub(102, "Test Show", 1, 2, "Test.Show.S01E02.EXTENDED.WEB", 5000),   # too long for the video: must be skipped
        sub(103, "Test Show", 1, 2, "Test.Show.S01E02.WEB", 800),             # the right one
    ],
    ("sync show", "1", "3"): [sub(104, "Sync Show", 1, 3, "Sync.Show.S01E03.WEB", 100)],
}
# searches by TMDB id of the show (parent_tmdb_id), as embedded players give no name
ID_CATALOG = {
    ("5550", "1", "1"): [
        sub(105, "Id Show", 1, 1, "Id.Show.S01E01.WEB", 300, tmdb=5550),
        sub(106, "Other Show", 1, 1, "Other.Show.S01E01.WEB", 9000, tmdb=9999),  # filed under another id: must be rejected
    ],
    ("5550", "1", "2"): [sub(107, "Id Show", 1, 2, "Id.Show.S01E02.WEB", 300, tmdb=5550)],
}
FILE_OF = {101: "good.srt", 102: "long.srt", 103: "good.srt", 104: "good.srt", 105: "good.srt", 106: "good.srt", 107: "good.srt"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if self.headers.get("Api-Key") != KEY:
            self._json(403, {"message": "You cannot consume this service"})
            return False
        if not (self.headers.get("User-Agent") or "").startswith("subtitle-sync"):
            problems.append(f"bad user agent: {self.headers.get('User-Agent')}")
        return True

    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/stats":
            return self._json(200, {"downloads": downloads, "problems": problems})
        if u.path.startswith("/files/"):
            data = (FILES / u.path.rsplit("/", 1)[1]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-subrip")
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/api/v1/subtitles":
            if not self._auth():
                return
            q = parse_qsl(u.query)
            if [k for k, _ in q] != sorted(k for k, _ in q):
                problems.append(f"parameters not sorted: {u.query}")
            p = dict(q)
            if "parent_tmdb_id" in p:
                hits = ID_CATALOG.get((p["parent_tmdb_id"], p.get("season_number"), p.get("episode_number")), [])
            else:
                hits = CATALOG.get((p.get("query", ""), p.get("season_number"), p.get("episode_number")), [])
            return self._json(200, {"total_count": len(hits), "total_pages": 1, "per_page": 50, "page": 1, "data": hits})
        self._json(404, {"message": "not found"})

    def do_POST(self):
        u = urlsplit(self.path)
        if u.path == "/api/v1/download":
            if not self._auth():
                return
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            fid = int(body.get("file_id") or dict(parse_qsl(u.query)).get("file_id"))
            downloads[fid] = downloads.get(fid, 0) + 1
            return self._json(200, {"link": f"http://127.0.0.1:{PORT}/files/{FILE_OF[fid]}", "file_name": f"{fid}.srt",
                                    "requests": sum(downloads.values()), "remaining": 100, "message": "", "reset_time": "", "reset_time_utc": ""})
        self._json(404, {"message": "not found"})


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
