"""The Firefox packaging and signing tools. Signing is tested against a local stand-in for addons.mozilla.org."""
import base64
import email
import hashlib
import hmac
import io
import json
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
import package_firefox  # noqa: E402
import sign_firefox  # noqa: E402

GUID = "subtitle-sync@danielzhang122"
ISSUER, SECRET = "user:1:23", "test-secret-do-not-print-0123456789"


def _signed_xpi():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("manifest.json", "{}")
        z.writestr("META-INF/cose.sig", "signed")
    return buf.getvalue()


class Amo(ThreadingHTTPServer):
    """A stand-in for AMO. Adjust `behaviour` to steer it; it checks every token it gets."""

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server_address[1]}"
        self.versions, self.requests, self.uploads, self.tokens = {}, [], {}, []
        self.xpi = _signed_xpi()
        self.behaviour = {"valid": True, "messages": [], "status_after": "public", "unreviewed_polls": 1, "reject": None, "hash": None, "fail_once_500": False}
        self.polls = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, status, data):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorised(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("JWT "):
            self._json(401, {"detail": "Authentication credentials were not provided."})
            return False
        self.server.tokens.append(auth[4:])
        head, body, sig = auth[4:].split(".")
        good = hmac.new(SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
        pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
        if base64.urlsafe_b64decode(pad(sig)) != good:
            self._json(401, {"detail": "Bad signature."})
            return False
        claims = json.loads(base64.urlsafe_b64decode(pad(body)))
        if claims["iss"] != ISSUER or not 0 < claims["exp"] - claims["iat"] <= 300 or not claims.get("jti"):
            self._json(401, {"detail": "Bad claims."})
            return False
        if self.server.behaviour["reject"]:
            self._json(*self.server.behaviour["reject"])
            return False
        return True

    def _version_details(self, v):
        file = {"status": "unreviewed", "url": f"{self.server.url}/files/signed.xpi", "hash": None}
        self.server.polls += 1
        if self.server.polls > self.server.behaviour["unreviewed_polls"]:
            file["status"] = self.server.behaviour["status_after"]
            file["hash"] = self.server.behaviour["hash"] or "sha256:" + hashlib.sha256(self.server.xpi).hexdigest()
        return {"version": v, "file": file}

    def do_GET(self):
        self.server.requests.append(("GET", self.path))
        if not self._authorised():
            return
        if self.path.startswith("/api/v5/addons/upload/"):
            if self.server.behaviour["fail_once_500"]:
                self.server.behaviour["fail_once_500"] = False
                return self._json(503, {"detail": "busy"})
            uid = self.path.rstrip("/").rsplit("/", 1)[1]
            return self._json(200, {"uuid": uid, "processed": True, "valid": self.server.behaviour["valid"],
                                    "validation": {"messages": self.server.behaviour["messages"]}})
        if "/versions/v" in self.path:
            v = self.path.rstrip("/").rsplit("/v", 1)[1]
            if v not in self.server.versions:
                return self._json(404, {"detail": "Not found."})
            return self._json(200, self._version_details(v))
        if self.path == "/files/signed.xpi":
            self.send_response(200)
            self.send_header("Content-Length", str(len(self.server.xpi)))
            self.end_headers()
            self.wfile.write(self.server.xpi)
            return
        self._json(404, {"detail": "Not found."})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        self.server.requests.append(("POST", self.path))
        if not self._authorised():
            return
        assert self.path == "/api/v5/addons/upload/"
        msg = email.message_from_bytes(b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
        form = {p.get_param("name", header="content-disposition"): p for p in msg.get_payload()}
        assert form["channel"].get_payload() == "unlisted"
        data = form["upload"].get_payload(decode=True)
        names = zipfile.ZipFile(io.BytesIO(data)).namelist()
        assert "manifest.json" in names
        self.server.uploads["u-1"] = names
        self._json(201, {"uuid": "u-1", "processed": False, "valid": False})

    def do_PUT(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append(("PUT", self.path))
        if not self._authorised():
            return
        assert self.path == f"/api/v5/addons/addon/{GUID.replace('@', '%40')}/"
        assert json.loads(raw) == {"version": {"upload": "u-1"}}
        version = package_firefox.read_manifest()["version"]
        if version in self.server.versions:
            return self._json(409, {"version": ["Version already exists."]})
        self.server.versions[version] = True
        self._json(201, {"guid": GUID, "version": {"version": version}})


@pytest.fixture
def amo(monkeypatch):
    server = Amo()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("AMO_JWT_ISSUER", ISSUER)
    monkeypatch.setenv("AMO_JWT_SECRET", SECRET)
    yield server
    server.shutdown()
    server.server_close()


def sign(amo, tmp_path, *extra):
    return sign_firefox.main(["--base-url", amo.url, "--dist", str(tmp_path), "--every", "0.01", *extra])


VERSION = package_firefox.read_manifest()["version"]


def _no_secret(capsys, tmp_path):
    out = capsys.readouterr()
    text = out.out + out.err
    assert SECRET not in text
    for f in tmp_path.iterdir():
        assert SECRET.encode() not in f.read_bytes()
    return text


# ---- packaging -----------------------------------------------------------------------------------

def test_zip_is_what_mozilla_needs(tmp_path):
    out, version, names, skipped = package_firefox.build(dist_dir=tmp_path)
    assert out.name == f"subtitle-sync-firefox-{version}.zip"
    raw = [i.orig_filename for i in zipfile.ZipFile(out).infolist()]
    assert "manifest.json" in raw and "background.js" in raw and "content/video.js" in raw
    assert not any("\\" in n for n in raw)
    # the raw bytes too: Python tidies backslashes when it reads a zip
    blob = out.read_bytes()
    assert b"content\\video.js" not in blob and b"content/video.js" in blob
    assert not any(n.startswith("tests/") for n in raw)
    assert "tests/unit.js" in skipped


def test_build_gives_the_same_zip_twice(tmp_path):
    first, *_ = package_firefox.build(dist_dir=tmp_path)
    a = first.read_bytes()
    second, *_ = package_firefox.build(dist_dir=tmp_path)
    assert second.read_bytes() == a


def test_manifest_meets_mozillas_rules():
    gecko = package_firefox.read_manifest()["browser_specific_settings"]["gecko"]
    assert gecko["id"] == GUID
    assert gecko["data_collection_permissions"]["required"]
    assert "none" not in gecko["data_collection_permissions"]["required"]
    assert int(gecko["strict_min_version"].split(".")[0]) >= 140


def _small_ext(tmp_path, manifest=None, popup='<script src="popup.js"></script>'):
    ext = tmp_path / "ext"
    (ext / "tests").mkdir(parents=True, exist_ok=True)
    (ext / "tests" / "unit.js").write_text("x")
    (ext / "popup.html").write_text(popup)
    (ext / "popup.js").write_text('import "./a.js";')
    (ext / "a.js").write_text("")
    (ext / "manifest.json").write_text(json.dumps(manifest or {"version": "1.0", "action": {"default_popup": "popup.html"}}))
    return ext


def test_missing_reference_stops_the_build(tmp_path):
    ext = _small_ext(tmp_path, popup='<script src="tests/unit.js"></script>')
    with pytest.raises(package_firefox.PackageError, match="tests/unit.js"):
        package_firefox.build(ext, tmp_path / "d")
    ext = _small_ext(tmp_path, {"version": "1.0", "background": {"scripts": ["gone.js"]}}, popup="")
    with pytest.raises(package_firefox.PackageError, match="gone.js"):
        package_firefox.build(ext, tmp_path / "d")


@pytest.mark.parametrize("bad", ["1.0-beta", "01.2", "1.2.3.4.5", ""])
def test_bad_version_stops_the_build(tmp_path, bad):
    ext = _small_ext(tmp_path, {"version": bad})
    with pytest.raises(package_firefox.PackageError, match="isn't valid"):
        package_firefox.build(ext, tmp_path / "d")


# ---- signing -------------------------------------------------------------------------------------

def test_token_is_as_amo_documents():
    head, body, sig = sign_firefox.make_jwt("me", "s3cret", now=1000).split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    assert json.loads(base64.urlsafe_b64decode(pad(head))) == {"alg": "HS256", "typ": "JWT"}
    claims = json.loads(base64.urlsafe_b64decode(pad(body)))
    assert claims["iss"] == "me" and claims["iat"] == 1000 and claims["exp"] == 1060 and claims["jti"]
    assert base64.urlsafe_b64decode(pad(sig)) == hmac.new(b"s3cret", f"{head}.{body}".encode(), hashlib.sha256).digest()
    assert claims["jti"] != json.loads(base64.urlsafe_b64decode(pad(sign_firefox.make_jwt("me", "s3cret", now=1000).split(".")[1])))["jti"]


def test_full_flow_saves_the_signed_file(amo, tmp_path, capsys):
    assert sign(amo, tmp_path) == 0
    out = tmp_path / f"subtitle-sync-firefox-{VERSION}-signed.xpi"
    assert out.read_bytes() == amo.xpi
    methods = [m for m, _ in amo.requests]
    assert methods.index("POST") < methods.index("PUT")
    assert not any(n.startswith("tests/") for n in amo.uploads["u-1"])
    assert len(set(amo.tokens)) == len(amo.tokens), "a new token every request"
    text = _no_secret(capsys, tmp_path)
    assert "Drag that file" in text


def test_no_key_says_how(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("AMO_JWT_ISSUER", raising=False)
    monkeypatch.delenv("AMO_JWT_SECRET", raising=False)
    assert sign_firefox.main(["--dist", str(tmp_path)]) == 1
    assert "AMO_JWT_SECRET" in capsys.readouterr().err
    assert not list(tmp_path.iterdir())


def test_same_version_twice_says_to_raise_it_and_uploads_nothing(amo, tmp_path, capsys):
    amo.versions[VERSION] = True
    assert sign(amo, tmp_path) == 1
    assert "Raise" in _no_secret(capsys, tmp_path)
    assert "POST" not in [m for m, _ in amo.requests]


def test_validation_problems_in_plain_words_and_nothing_submitted(amo, tmp_path, capsys):
    amo.behaviour.update(valid=False, messages=[{"type": "error", "message": "Bad manifest key", "description": ["Remove it."], "file": "manifest.json"}])
    assert sign(amo, tmp_path) == 1
    text = _no_secret(capsys, tmp_path)
    assert "Bad manifest key" in text and "Remove it." in text and "manifest.json" in text
    assert "PUT" not in [m for m, _ in amo.requests]


def test_bad_key_hints_at_the_key_page(amo, tmp_path, capsys):
    amo.behaviour["reject"] = (401, {"detail": "Unknown JWT iss (issuer)."})
    assert sign(amo, tmp_path) == 1
    text = _no_secret(capsys, tmp_path)
    assert "Unknown JWT iss" in text and "api/key" in text


def test_brief_server_trouble_doesnt_end_the_wait(amo, tmp_path, capsys):
    amo.behaviour["fail_once_500"] = True
    assert sign(amo, tmp_path) == 0
    assert "trying again" in _no_secret(capsys, tmp_path)


def test_rejected_by_mozilla_saves_nothing(amo, tmp_path, capsys):
    amo.behaviour["status_after"] = "disabled"
    assert sign(amo, tmp_path) == 1
    assert "didn't approve" in _no_secret(capsys, tmp_path)
    assert not list(tmp_path.glob("*.xpi"))


def test_wrong_fingerprint_saves_nothing(amo, tmp_path, capsys):
    amo.behaviour["hash"] = "sha256:" + "0" * 64
    assert sign(amo, tmp_path) == 1
    assert "fingerprint" in _no_secret(capsys, tmp_path)
    assert not list(tmp_path.glob("*.xpi"))


def test_unsigned_download_saves_nothing(amo, tmp_path, capsys):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("manifest.json", "{}")
    amo.xpi = buf.getvalue()
    assert sign(amo, tmp_path) == 1
    assert "no Mozilla signature" in _no_secret(capsys, tmp_path)
    assert not list(tmp_path.glob("*.xpi*"))


def test_download_existing_fetches_without_uploading(amo, tmp_path, capsys):
    amo.versions[VERSION] = True
    assert sign(amo, tmp_path, "--download-existing") == 0
    assert (tmp_path / f"subtitle-sync-firefox-{VERSION}-signed.xpi").exists()
    assert "POST" not in [m for m, _ in amo.requests]
    _no_secret(capsys, tmp_path)


def test_key_is_never_sent_over_plain_http(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("AMO_JWT_ISSUER", ISSUER)
    monkeypatch.setenv("AMO_JWT_SECRET", SECRET)
    assert sign_firefox.main(["--base-url", "http://example.com", "--dist", str(tmp_path)]) == 1
    assert "https" in capsys.readouterr().err


def test_token_isnt_sent_to_another_server(amo):
    client = sign_firefox.Amo(amo.url, ISSUER, SECRET, GUID)
    other = Amo()
    threading.Thread(target=other.serve_forever, daemon=True).start()
    try:
        with pytest.raises(sign_firefox.HttpFailure):
            client.download(f"{other.url}/files/signed.xpi")  # the stand-in answers 401 with no token
        assert other.tokens == []
    finally:
        other.shutdown()
        other.server_close()


# ---- the packaged zip in real Firefox ---------------------------------------------------------------

def test_packaged_zip_runs_in_firefox(tmp_path):
    pytest.importorskip("selenium")
    sys.path.insert(0, str(REPO / "tests" / "firefox"))
    import harness
    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options

    out, *_ = package_firefox.build(dist_dir=tmp_path)
    opts = Options()
    opts.add_argument("-headless")
    opts.set_preference("extensions.webextensions.uuids", json.dumps({harness.EXT_ID: harness.UUID}))
    opts.set_preference("media.volume_scale", "0.0")
    try:
        d = webdriver.Firefox(options=opts)
    except Exception as err:
        pytest.skip(f"Firefox unavailable: {err}")
    try:
        d.install_addon(str(out), temporary=True)
        try:
            harness.open_ext(d, "popup.html")
        except RuntimeError:  # its 5 s wait can run out on a busy machine
            harness.open_ext(d, "popup.html")
        for _ in range(50):
            ready = d.execute_script("return !!document.getElementById('language') && document.getElementById('language').options.length > 0")
            if ready:
                break
            time.sleep(0.2)
        assert ready, "the popup's script ran from the zip"
        # the background page answers (it imported every module from the zip)
        state = d.execute_async_script("""const done = arguments[0];
          browser.tabs.query({}).then(ts => browser.runtime.sendMessage({type: 'get-state', tabId: ts[0].id})).then(done, e => done({error: String(e)}));""")
        assert "error" not in state and "status" in state, state
        # settings are stored and read back by the packaged code
        got = d.execute_async_script("""const done = arguments[0];
          browser.storage.local.set({probe: 1}).then(() => browser.storage.local.get('probe')).then(done, e => done({error: String(e)}));""")
        assert got == {"probe": 1}
        assert d.execute_script("return browser.runtime.getManifest().browser_specific_settings.gecko.id") == GUID
    finally:
        d.quit()
