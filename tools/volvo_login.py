#!/usr/bin/env python3
"""One-time Volvo ID login for the PebbleKey Pebble app.

Runs the OAuth authorisation-code flow (with PKCE) in your browser and prints a
setup code to paste into the watchapp's settings page in the Pebble phone app.

Usage:
    python3 tools/volvo_login.py

Your app's client ID, client secret, VCC API key, redirect URI and the car's VIN
are asked for on first run and remembered in tools/.volvo.json (git-ignored,
readable only by you). Standard library only; needs Python 3.8+.
"""

import argparse
import base64
import errno
import getpass
import hashlib
import http.server
import json
import os
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

AUTH_URL = "https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/auth"
TOKEN_URL = "https://auth.volvocars.com/realms/volvocars/protocol/openid-connect/token"
DEFAULT_REDIRECT = "http://localhost:8765/callback"
# What each scope is for. The script asks only for those enabled on the Volvo application.
SCOPES = {
    "openid": "signing in",
    "conve:lock": "locking",
    "conve:unlock": "unlocking",
    "conve:climatization_start_stop": "climate on/off",
    "conve:doors_status": "open doors on the watch",
    "conve:lock_status": "lock state on the watch",
    "conve:fuel_status": "battery level on the watch",
    "conve:battery_charge_level": "battery level on the watch",
    "location:read": "distance check before unlocking",
}
REQUIRED_SCOPES = ("openid", "conve:lock", "conve:unlock")
SETUP_PREFIX = "EX30K1."
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".volvo.json")

FIELDS = [
    # key, prompt, secret?
    ("client_id", "Client ID", False),
    ("client_secret", "Client secret", True),
    ("api_key", "VCC API key (primary)", True),
    ("vin", "VIN of the car (17 characters)", False),
    ("redirect_uri", "Redirect URI registered for the app", False),
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_pkce():
    verifier = b64url(secrets.token_bytes(48))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def make_setup_code(cfg: dict, refresh_token: str) -> str:
    payload = {
        "i": cfg["client_id"],
        "s": cfg["client_secret"],
        "k": cfg["api_key"],
        "v": cfg["vin"],
        "r": refresh_token,
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return SETUP_PREFIX + b64url(raw)


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    fd = os.open(CONFIG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    os.chmod(CONFIG_PATH, 0o600)


def ask_config(saved: dict, reconfigure: bool) -> dict:
    cfg = dict(saved)
    ask_all = reconfigure or not saved
    cfg.setdefault("redirect_uri", DEFAULT_REDIRECT)
    changed = False
    for key, prompt, is_secret in FIELDS:
        current = cfg.get(key, "")
        if current and not ask_all:
            continue
        if is_secret:
            hint = " [keep saved]" if current else ""
            value = getpass.getpass(f"{prompt}{hint}: ").strip()
        else:
            hint = f" [{current}]" if current else ""
            value = input(f"{prompt}{hint}: ").strip()
        if value:
            cfg[key] = value
            changed = True
        elif not current:
            sys.exit(f"{prompt} is required.")
    cfg["vin"] = cfg["vin"].upper()
    if len(cfg["vin"]) != 17:
        sys.exit(f"A VIN has 17 characters; got {len(cfg['vin'])}.")
    if changed or cfg != saved:
        save_config(cfg)
        print(f"Saved to {CONFIG_PATH}")
    return cfg


def listen_for_redirect(redirect_uri: str):
    """Start listening on the redirect URI's local port.

    Returns a function that waits for the browser redirect and returns its query parameters.
    Listening starts here, before the browser opens, so a busy port is reported straight away.
    """
    target = urllib.parse.urlsplit(redirect_uri)
    port = target.port or 80
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parts = urllib.parse.urlsplit(self.path)
            if parts.path != (target.path or "/"):
                self.send_error(404)
                return
            result.update({k: v[0] for k, v in urllib.parse.parse_qs(parts.query).items()})
            ok = "code" in result
            body = (
                "<h1>Signed in</h1><p>You can close this tab and go back to the terminal.</p>"
                if ok
                else "<h1>Login failed</h1><p>See the terminal for details.</p>"
            )
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def log_message(self, *args):
            pass

    try:
        server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    except OSError as err:
        if err.errno != errno.EADDRINUSE:
            raise
        sys.exit(
            f"Port {port} is already in use, most likely by another run of this script that is\n"
            "still waiting for a login. Stop that one with Ctrl-C in its terminal (or finish the\n"
            "login in its browser tab), then run this again."
        )

    def wait() -> dict:
        with server:
            while not result:
                server.handle_request()
        return result

    return wait


def paste_redirect() -> dict:
    """For a redirect URI this script cannot listen on: have the user paste the final URL."""
    print(
        "\nAfter signing in, the browser lands on your redirect URI (the page itself may fail\n"
        "to load, that is fine). Copy the full address from the address bar and paste it here."
    )
    url = input("Redirected URL: ").strip()
    query = urllib.parse.urlsplit(url).query
    return {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}


def tls_context() -> ssl.SSLContext:
    """Certificate-verifying TLS context that also works on a python.org macOS install.

    That Python ships without any trusted root certificates until its
    'Install Certificates.command' has been run, so fall back to the system bundle.
    """
    context = ssl.create_default_context()
    if not context.cert_store_stats()["x509_ca"] and not context.get_ca_certs():
        for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if os.path.exists(bundle):
                context.load_verify_locations(cafile=bundle)
                break
    return context


def exchange_code(cfg: dict, code: str, verifier: str) -> dict:
    basic = base64.b64encode(
        "{}:{}".format(
            urllib.parse.quote(cfg["client_id"], safe=""),
            urllib.parse.quote(cfg["client_secret"], safe=""),
        ).encode("utf-8")
    ).decode("ascii")
    body = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": cfg["redirect_uri"],
            "code_verifier": verifier,
        }
    ).encode("ascii")
    request = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={
            "content-type": "application/x-www-form-urlencoded",
            "authorization": "Basic " + basic,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30, context=tls_context()) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        sys.exit(f"Token exchange failed (HTTP {err.code}): {detail}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach Volvo's login server: {err.reason}")


def auth_url(cfg: dict, scope: str, state: str, challenge: str) -> str:
    return AUTH_URL + "?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": cfg["client_id"],
            "redirect_uri": cfg["redirect_uri"],
            "scope": scope,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        quote_via=urllib.parse.quote,
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def scope_is_enabled(cfg: dict, scope: str) -> bool:
    """Ask Volvo's login page whether the application may request this scope.

    For a scope the application does not have, Volvo answers the login request itself with a
    redirect back to the app carrying error=invalid_scope; no sign-in is involved. Anything
    else (the login page, a network problem) counts as enabled, so a real login decides.
    """
    opener = urllib.request.build_opener(
        _NoRedirect, urllib.request.HTTPSHandler(context=tls_context())
    )
    url = auth_url(cfg, f"openid {scope}", "probe", make_pkce()[1])
    try:
        opener.open(url, timeout=15).close()
    except urllib.error.HTTPError as err:
        location = err.headers.get("location", "")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
        return query.get("error", [""])[0] != "invalid_scope"
    except urllib.error.URLError:
        pass
    return True


def pick_scopes(cfg: dict) -> str:
    """The scopes to request: every one this app can use that the application has enabled."""
    print("Checking which scopes your Volvo application has ...")
    wanted, skipped = [], []
    for name in SCOPES:
        if name == "openid" or scope_is_enabled(cfg, name):
            wanted.append(name)
        else:
            skipped.append(name)
    absent = [name for name in REQUIRED_SCOPES if name in skipped]
    if absent:
        sys.exit(
            "Your Volvo application lacks {}, which this app cannot work without.\n"
            "Enable it at developer.volvocars.com and run this again.".format(" and ".join(absent))
        )
    if skipped:
        print("Not enabled on the application, so these are left out:")
        for name in skipped:
            print(f"  {name}  ({SCOPES[name]})")
    return " ".join(wanted)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--reconfigure", action="store_true", help="ask for all app details again")
    parser.add_argument("--scope", help="scopes to request (default: all the app can use that your Volvo application has)")
    parser.add_argument("--no-browser", action="store_true", help="print the login URL instead of opening it")
    args = parser.parse_args()

    cfg = ask_config(load_config(), args.reconfigure)
    scope = args.scope or pick_scopes(cfg)

    verifier, challenge = make_pkce()
    state = secrets.token_urlsafe(16)
    login_url = auth_url(cfg, scope, state, challenge)

    target = urllib.parse.urlsplit(cfg["redirect_uri"])
    local = target.scheme == "http" and target.hostname in ("localhost", "127.0.0.1")
    wait_for_redirect = listen_for_redirect(cfg["redirect_uri"]) if local else None

    print("\nSign in with your Volvo ID and tick 'Remember me' so the login lasts.")
    if args.no_browser or not webbrowser.open(login_url):
        print("Open this URL in your browser:\n\n" + login_url + "\n")

    if wait_for_redirect:
        print(f"Waiting for the redirect to {cfg['redirect_uri']} ... (Ctrl-C to stop)")
        params = wait_for_redirect()
    else:
        params = paste_redirect()

    if params.get("error") == "invalid_scope":
        sys.exit(
            "Login failed: Volvo refused the requested scopes ({}).\n"
            "Enable them on your application at developer.volvocars.com, or pass the ones it has "
            "with --scope.".format(params.get("error_description", "no details given"))
        )
    if "error" in params:
        sys.exit(f"Login failed: {params['error']}: {params.get('error_description', '')}")
    if params.get("state") != state:
        sys.exit("Login failed: the state value did not match. Start again.")
    if "code" not in params:
        sys.exit("Login failed: no authorisation code in the redirect.")

    tokens = exchange_code(cfg, params["code"], verifier)
    if not tokens.get("refresh_token"):
        sys.exit("Volvo returned no refresh token; cannot continue.")

    print(
        "\nLogin OK. Access tokens last {} s; the refresh token is valid for {}.".format(
            tokens.get("expires_in", "?"),
            "{} h if unused".format(round(tokens["refresh_expires_in"] / 3600, 1))
            if tokens.get("refresh_expires_in")
            else "an unstated time",
        )
    )
    granted = set(tokens.get("scope", "").split())
    missing = [name for name in scope.split() if name not in granted]
    if granted and missing:
        print("\nRequested but not granted, so these will not work:")
        for name in missing:
            print(f"  {name}  ({SCOPES.get(name, 'custom')})")
    print(
        "\nSetup code (contains your client secret and login; treat it like a password).\n"
        "Paste it into PebbleKey > Settings in the Pebble phone app:\n"
    )
    print(make_setup_code(cfg, tokens["refresh_token"]))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nStopped.")
