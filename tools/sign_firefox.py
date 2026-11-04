"""Have Mozilla sign the extension, so it stays installed in normal Firefox.

    $env:AMO_JWT_ISSUER = Read-Host "AMO JWT issuer"
    $env:AMO_JWT_SECRET = Read-Host "AMO JWT secret"
    python tools/sign_firefox.py

Builds the zip, uploads it to addons.mozilla.org (AMO) as an unlisted version ("On your own": signed but
not published), waits for Mozilla's checks and signature, and saves the signed .xpi in dist/.
The key is read from those two environment variables only; it is never printed or saved.

If waiting was interrupted after the upload went through, run it again with --download-existing.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import package_firefox

AMO = "https://addons.mozilla.org"
KEYS_PAGE = "https://addons.mozilla.org/developers/addon/api/key/"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class SignError(Exception):
    pass


class HttpFailure(SignError):
    def __init__(self, status, detail):
        super().__init__(f"addons.mozilla.org answered {status}: {detail}")
        self.status = status
        self.detail = detail


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(issuer, secret, now=None):
    """A token as AMO asks for: HS256, unique jti, in UTC, valid for under 5 minutes."""
    now = int(time.time() if now is None else now)
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"iss": issuer, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def multipart(fields, files):
    """(body, content type) for form fields and files given as {name: (filename, bytes)}."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, (filename, data) in files.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                     "Content-Type: application/zip\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def error_detail(raw):
    """AMO's error answer in plain words: all its messages, without the JSON."""
    try:
        data = json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace")[:500]
    out = []

    def walk(x):
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)

    walk(data)
    return " ".join(out)[:1000] or str(data)[:500]


class Amo:
    def __init__(self, base, issuer, secret, guid):
        parts = urllib.parse.urlsplit(base)
        if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in LOOPBACK):
            raise SignError(f"Won't send your key to {base}: it must be an https address.")
        self.base = base.rstrip("/")
        self.origin = (parts.scheme, parts.netloc)
        self.issuer, self.secret = issuer, secret
        self.addon = f"{self.base}/api/v5/addons/addon/{urllib.parse.quote(guid, safe='')}"

    def _send(self, method, url, data=None, content_type=None, raw=False):
        req = urllib.request.Request(url, data=data, method=method)
        target = urllib.parse.urlsplit(url)
        if (target.scheme, target.netloc) == self.origin:
            # "unredirected": a redirect to some other server must not receive the token
            req.add_unredirected_header("Authorization", f"JWT {make_jwt(self.issuer, self.secret)}")
        if content_type:
            req.add_header("Content-Type", content_type)
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                body = res.read()
        except urllib.error.HTTPError as err:
            raise HttpFailure(err.code, error_detail(err.read())) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise HttpFailure(0, f"couldn't reach the server ({getattr(err, 'reason', err)})") from None
        return body if raw else json.loads(body)

    def get(self, url):
        return self._send("GET", url)

    def version(self, version):
        """The version's details, or None if AMO has no such version (or add-on) yet."""
        try:
            return self.get(f"{self.addon}/versions/v{version}/")
        except HttpFailure as err:
            if err.status == 404:
                return None
            raise

    def upload(self, zip_path):
        body, ctype = multipart({"channel": "unlisted"}, {"upload": (zip_path.name, zip_path.read_bytes())})
        return self._send("POST", f"{self.base}/api/v5/addons/upload/", body, ctype)

    def upload_status(self, upload_uuid):
        return self.get(f"{self.base}/api/v5/addons/upload/{upload_uuid}/")

    def submit(self, upload_uuid):
        # creates the add-on the first time, and a new version after that
        return self._send("PUT", f"{self.addon}/", json.dumps({"version": {"upload": upload_uuid}}).encode(), "application/json")

    def download(self, url):
        return self._send("GET", url, raw=True)


def poll(fetch, done, what, timeout, every, sleep=time.sleep):
    """Ask until done(answer). Brief server or network trouble doesn't end the wait; refusals do."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            answer = fetch()
            if done(answer):
                return answer
        except HttpFailure as err:
            if err.status and err.status < 500 and err.status != 429:
                raise
            print(f"  (trouble asking about {what}: {err}; trying again)")
        if time.monotonic() >= deadline:
            raise TimeoutError(what)
        sleep(every)


def explain_validation(result):
    """Mozilla's check results in plain words. True if the upload passed."""
    validation = result.get("validation") or {}
    messages = validation.get("messages") or []
    errors = [m for m in messages if m.get("type") == "error"]
    warnings = [m for m in messages if m.get("type") == "warning"]
    for kind, items in (("Problem", errors), ("Warning", warnings)):
        for m in items:
            where = f" (in {m['file']})" if m.get("file") else ""
            text = m.get("message") or ""
            desc = m.get("description") or ""
            if isinstance(desc, list):
                desc = " ".join(str(x) for x in desc)
            print(f"  {kind}{where}: {text}{f' - {desc}' if desc else ''}")
    if result.get("valid"):
        print(f"Mozilla's checks passed ({len(warnings)} warnings).")
        return True
    print(f"Mozilla's checks failed with {len(errors)} problems; nothing was submitted. Fix them and run this again.")
    return False


def auth_hint(err):
    if isinstance(err, HttpFailure) and err.status in (401, 403):
        return (f"\nCheck your key at {KEYS_PAGE} (you may also need to accept Mozilla's distribution agreement there, "
                "and a computer clock that's off makes the key fail too).")
    return ""


def wait_and_save(amo, version, dist_dir, opts):
    print("Waiting for Mozilla's signature...")
    try:
        details = poll(lambda: amo.version(version),
                       lambda v: v is not None and (v.get("file") or {}).get("status") != "unreviewed",
                       "the signature", opts.sign_timeout, opts.every)
    except TimeoutError:
        raise SignError(f"Mozilla hasn't signed it after {opts.sign_timeout // 60} minutes. It may still finish: "
                        "run this again later with --download-existing.") from None
    file = details.get("file") or {}
    if file.get("status") != "public":
        raise SignError(f'Mozilla didn\'t approve version {version} (status "{file.get("status")}"). '
                        "Look at it under Manage My Submissions on addons.mozilla.org.")
    if not file.get("url"):
        raise SignError("Mozilla's answer had no download address for the signed file.")
    data = amo.download(file["url"])
    want = file.get("hash")
    if want and want != "sha256:" + hashlib.sha256(data).hexdigest():
        raise SignError("The downloaded file doesn't match the fingerprint Mozilla gave, so it wasn't saved. Run this again with --download-existing.")
    out = dist_dir / f"subtitle-sync-firefox-{version}-signed.xpi"
    dist_dir.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".xpi.tmp")
    tmp.write_bytes(data)
    try:
        with zipfile.ZipFile(tmp) as z:
            if not any(n.startswith("META-INF/") for n in z.namelist()):
                raise SignError("The downloaded file has no Mozilla signature inside, so it wasn't saved.")
    except zipfile.BadZipFile:
        tmp.unlink()
        raise SignError("The downloaded file isn't a valid add-on, so it wasn't saved.") from None
    except SignError:
        tmp.unlink()
        raise
    tmp.replace(out)
    print(f"Signed: {out}")
    print("Drag that file into a Firefox window and choose Add. It stays installed after restarts.")
    return out


def run(opts):
    issuer, secret = os.environ.get("AMO_JWT_ISSUER", ""), os.environ.get("AMO_JWT_SECRET", "")
    if not issuer or not secret:
        raise SignError(f"Set AMO_JWT_ISSUER and AMO_JWT_SECRET first. Your key is at {KEYS_PAGE}\n"
                        'In PowerShell (keeps it out of your command history):\n'
                        '  $env:AMO_JWT_ISSUER = Read-Host "AMO JWT issuer"\n'
                        '  $env:AMO_JWT_SECRET = Read-Host "AMO JWT secret"')
    zip_path, version, _, _ = package_firefox.build(opts.ext_dir, opts.dist)
    guid = package_firefox.read_manifest(opts.ext_dir)["browser_specific_settings"]["gecko"]["id"]
    print(f"Built {zip_path}")
    amo = Amo(opts.base_url, issuer, secret, guid)
    existing = amo.version(version)
    if opts.download_existing:
        if existing is None:
            raise SignError(f"addons.mozilla.org has no version {version} of this add-on to download.")
        return wait_and_save(amo, version, opts.dist, opts)
    if existing is not None:
        raise SignError(f'Version {version} was already submitted, and Mozilla never accepts the same version twice. '
                        'Raise "version" in firefox-extension/manifest.json and run this again. '
                        "(To fetch the signed file of that earlier version instead, add --download-existing.)")
    print("Uploading...")
    upload_uuid = amo.upload(zip_path)["uuid"]
    print("Waiting for Mozilla's checks...")
    try:
        result = poll(lambda: amo.upload_status(upload_uuid), lambda u: u.get("processed"), "the checks", opts.check_timeout, opts.every)
    except TimeoutError:
        raise SignError(f"Mozilla's checks didn't finish in {opts.check_timeout // 60} minutes. Nothing was submitted; run this again later.") from None
    if not explain_validation(result):
        return None
    amo.submit(upload_uuid)
    return wait_and_save(amo, version, opts.dist, opts)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Have Mozilla sign the extension, and save the signed .xpi in dist/.")
    ap.add_argument("--download-existing", action="store_true", help="don't upload; fetch the signed file of the version already submitted")
    ap.add_argument("--base-url", default=AMO, help=argparse.SUPPRESS)
    ap.add_argument("--ext-dir", type=Path, default=package_firefox.EXT_DIR, help=argparse.SUPPRESS)
    ap.add_argument("--dist", type=Path, default=package_firefox.DIST_DIR, help=argparse.SUPPRESS)
    ap.add_argument("--every", type=float, default=5, help=argparse.SUPPRESS)
    ap.add_argument("--check-timeout", type=int, default=600, help=argparse.SUPPRESS)
    ap.add_argument("--sign-timeout", type=int, default=1800, help=argparse.SUPPRESS)
    return ap.parse_args(argv)


def main(argv=None):
    try:
        return 0 if run(parse_args(argv)) else 1
    except (SignError, package_firefox.PackageError) as err:
        print(f"Not signed: {err}{auth_hint(err)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
