#!/usr/bin/env python3
"""Disposable, synthetic public-peer acceptance; never a deployment command.

A single fresh Chromium process drives both owners' login/private ZIP imports
and observes shared/revoked/deleted pages. HTTP APIs drive sharing mutations.
This is browser-assisted/API coverage, not an all-UI usability qualification.
The remote peer must be empty, disposable and independently time-limited.
"""

import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import secrets
import select
import signal
import socket
import ssl
import subprocess
import tempfile
import time
from urllib import error, parse, request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/synthetic/facebook/photos/synthetic-postcard.png"
FIXTURE_SHA256 = "e5c189116fe149c5c7c4385cd6693942a11c8ce8e58379c4b33a3aa47be2af58"
TUNNEL_IMAGE = (
    "cloudflare/cloudflared:2026.9.3@"
    "sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c"
)
APP_IMAGE = "clean-bookface:qualification"
MAX_RESPONSE = 16 * 1024 * 1024


class Failure(Exception):
    """Only a fixed code and optional HTTP status may enter the receipt."""

    def __init__(self, code, status=None):
        super().__init__(code)
        self.code = code
        self.status = status


def require(condition, code):
    if not condition:
        raise Failure(code)


def mask(value):
    # Values validated before this call; no multiline workflow-command input.
    print("::add-mask::" + value, flush=True)


def docker(arguments, checked=True, timeout=90):
    try:
        result = subprocess.run(
            ["docker", *arguments], capture_output=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired:
        raise Failure("DOCKER_TIMEOUT") from None
    if checked and result.returncode:
        raise Failure("DOCKER_" + arguments[0].upper().replace("-", "_"))
    return result


def inventory(kind):
    fields = {"container": "{{.Names}}", "volume": "{{.Name}}", "network": "{{.Name}}"}
    args = [kind, "ls"] + (["-a"] if kind == "container" else [])
    result = docker([*args, "--format", fields[kind]], checked=False)
    require(result.returncode == 0, "DOCKER_INVENTORY_" + kind.upper())
    return set(result.stdout.decode("utf-8").splitlines())


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = request.build_opener(NoRedirect, request.ProxyHandler({}))


def http(origin, path, user=None, data=None, raw=None, content_type=None):
    headers = {"Accept": "application/json"}
    if user:
        headers["Cookie"] = user["cookie"]
    body = raw
    if data is not None:
        fields = dict(data)
        if user:
            fields["csrf"] = user["csrf"]
        body = json.dumps(fields).encode()
    if body is not None:
        headers["Origin"] = origin
        headers["Content-Type"] = content_type or "application/json"
    call = request.Request(origin + path, data=body, headers=headers)
    try:
        response = HTTP.open(call, timeout=15)
    except error.HTTPError as caught:
        response = caught
    except (error.URLError, TimeoutError, OSError) as caught:
        reason = getattr(caught, "reason", caught)
        if isinstance(reason, socket.gaierror):
            code = "HTTP_DNS"
        elif isinstance(reason, ssl.SSLError):
            code = "HTTP_TLS"
        elif isinstance(reason, (TimeoutError, socket.timeout)):
            code = "HTTP_TIMEOUT"
        else:
            code = "HTTP_TRANSPORT"
        raise Failure(code) from None
    with response:
        payload = response.read(MAX_RESPONSE + 1)
        require(len(payload) <= MAX_RESPONSE, "HTTP_RESPONSE_LIMIT")
        return response.status, payload, response.headers


def expect_status(response, expected, code):
    if response[0] != expected:
        raise Failure(code, response[0])
    return response


def decode(response, code, expected=200):
    expect_status(response, expected, code)
    try:
        return json.loads(response[1])
    except (ValueError, UnicodeError):
        raise Failure(code + "_JSON") from None


def api(user, path, data=None):
    return http(user["origin"], path, user=user, data=data)


def wait_for(action, code, seconds=180):
    deadline = time.monotonic() + seconds
    last_code = "NOT_READY"
    while time.monotonic() < deadline:
        try:
            result = action()
            if result:
                return result
        except Failure as caught:
            # Only bounded readiness/delivery callers use this retry loop.
            last_code = caught.code
        time.sleep(2)
    raise Failure(code + "_" + last_code)


def multipart(fields, filename, payload, content_type):
    boundary = "synthetic-" + secrets.token_hex(12)
    pieces = []
    for key, value in fields.items():
        pieces.append(
            (f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"'
             f"\r\n\r\n{value}\r\n").encode()
        )
    pieces.extend([
        (f'--{boundary}\r\nContent-Disposition: form-data; name="files"; '
         f'filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n').encode(),
        payload,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    return b"".join(pieces), "multipart/form-data; boundary=" + boundary


BROWSER_DRIVER = r"""
import { chromium, expect } from '@playwright/test';
import { createInterface } from 'node:readline';
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { console.log(JSON.stringify({ok:false,code:'BROWSER_LAUNCH'})); process.exit(1); }
console.log(JSON.stringify({ok:true,ready:true}));
const pages = new Map();
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    let stage = 'COMMAND';
    try {
      if (m.action === 'close') { console.log(JSON.stringify({ok:true})); break; }
      if (m.action === 'login_import') {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.setDefaultNavigationTimeout(30000);
        pages.set(m.name, page);
        stage = 'LOGIN_NAVIGATION';
        await page.goto(m.origin + '/login');
        stage = 'LOGIN_FORM';
        await page.getByLabel('Username', {exact:true}).fill(m.name);
        await page.getByLabel('Password', {exact:true}).fill(m.password);
        await page.getByRole('button', {name:'Log in', exact:true}).click();
        await page.getByRole('heading', {name:'News feed', exact:true}).waitFor();
        stage = 'IMPORT_NAVIGATION';
        await page.goto(m.origin + '/imports');
        stage = 'IMPORT_UPLOAD';
        await page.getByLabel('Upload a ZIP export', {exact:true}).setInputFiles(m.zipPath);
        await page.getByRole('button', {name:'Import privately', exact:true}).click();
      } else if (m.action === 'observe') {
        stage = 'OBSERVE_NAVIGATION';
        const page = pages.get(m.name);
        const response = await page.goto(m.origin + m.path);
        stage = 'OBSERVE_STATUS';
        if (response?.status() !== m.status) throw new Error('status');
        stage = 'OBSERVE_TEXT';
        if (m.text) await page.getByText(m.text, {exact:true}).first().waitFor();
        if (m.privateImage) {
          const image = page.getByAltText('Private photo 1', {exact:true});
          await image.waitFor();
          stage = 'PRIVATE_IMAGE_LOAD';
          await expect.poll(() => image.evaluate(x => x.naturalWidth)).toBeGreaterThan(0);
        }
      } else { throw new Error('command'); }
      console.log(JSON.stringify({ok:true}));
    } catch { console.log(JSON.stringify({ok:false,code:'BROWSER_' + stage})); }
  }
} finally { await browser.close(); }
"""


class Browser:
    def __init__(self):
        self.process = subprocess.Popen(
            ["node", "--input-type=module", "-e", BROWSER_DRIVER],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True,
        )
        try:
            ready, _, _ = select.select([self.process.stdout], [], [], 30)
            require(bool(ready), "BROWSER_STARTUP_TIMEOUT")
            response = json.loads(self.process.stdout.readline())
            require(response.get("ready"), response.get("code", "BROWSER_STARTUP_FAILED"))
        except Exception:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=10)
            raise

    def call(self, **message):
        try:
            self.process.stdin.write(json.dumps(message) + "\n")
            self.process.stdin.flush()
            ready, _, _ = select.select([self.process.stdout], [], [], 90)
            require(bool(ready), "BROWSER_COMMAND_TIMEOUT")
            response = json.loads(self.process.stdout.readline())
            require(response.get("ok"), response.get("code", "BROWSER_FAILED"))
        except (BrokenPipeError, ValueError):
            raise Failure("BROWSER_PROCESS_FAILED") from None

    def close(self):
        try:
            if self.process.poll() is None:
                self.call(action="close")
                # Breaking readline's iterator leaves stdin alive. Send EOF so
                # Node can exit after the driver's awaited browser.close().
                self.process.stdin.close()
                self.process.wait(timeout=10)
            require(self.process.returncode == 0, "BROWSER_CLOSE_FAILED")
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=10)


class Lab:
    def __init__(self, prefix):
        self.prefix = prefix
        self.app = prefix + "-app"
        self.tunnel = prefix + "-tunnel"
        self.network = prefix + "-net"
        self.volume = prefix + "-data"
        self.created = []
        self.origin = None

    def start(self):
        for kind, name in self.resources():
            require(name not in inventory(kind), "RESOURCE_ALREADY_EXISTS")
        docker(["network", "create", "--label", "qualification=" + self.prefix, self.network])
        self.created.append(("network", self.network))
        docker(["volume", "create", "--label", "qualification=" + self.prefix, self.volume])
        self.created.append(("volume", self.volume))
        limits = [
            "--cpus=.5", "--memory=512m", "--pids-limit=64", "--read-only",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--label", "qualification=" + self.prefix, "--network", self.network,
        ]
        # Record exact ownership before run, since creation may outlive a timeout.
        self.created.append(("container", self.tunnel))
        docker(["run", "-d", "--name", self.tunnel, *limits, TUNNEL_IMAGE,
                "tunnel", "--no-autoupdate", "--protocol", "http2",
                "--url", "http://" + self.app + ":3000"])

        def tunnel_origin():
            logs = docker(["logs", self.tunnel], checked=False)
            text = (logs.stdout + logs.stderr).decode(errors="replace")
            if "failed to request quick Tunnel" in text:
                raise Failure("TUNNEL_API")
            match = re.search(r"https://[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com", text)
            return match.group() if match else None

        self.origin = wait_for(tunnel_origin, "TUNNEL_ORIGIN", 90)
        mask(self.origin)
        self.created.append(("container", self.app))
        docker(["run", "-d", "--name", self.app, *limits,
                "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                "--mount", "type=volume,source=" + self.volume + ",target=/data",
                "-e", "APP_ORIGIN=" + self.origin, "-e", "FEDERATION_ENABLED=true",
                "-e", "CLOUDFLARE_PROXY=true", APP_IMAGE])
        for name in [self.app, self.tunnel]:
            obj = json.loads(docker(["inspect", name]).stdout)[0]
            cfg = obj["HostConfig"]
            require(not cfg["PortBindings"], "PUBLISHED_PORT")
            require(cfg["Memory"] == 536870912 and cfg["NanoCpus"] == 500000000
                    and cfg["PidsLimit"] == 64, "RESOURCE_LIMIT")
            require(cfg["ReadonlyRootfs"] and "ALL" in cfg["CapDrop"], "CONTAINER_HARDENING")
            require(obj["Config"]["User"] not in ["", "0", "root"], "CONTAINER_ROOT")
        values = self.node(
            "const f=require('fs');console.log(JSON.stringify(['memory.max','cpu.max',"
            "'pids.max'].map(x=>f.readFileSync('/sys/fs/cgroup/'+x,'utf8').trim())))"
        )
        require(values == ["536870912", "50000 100000", "64"], "EFFECTIVE_CGROUPS")

    def node(self, source):
        return json.loads(docker(["exec", self.app, "node", "-e", source]).stdout)

    def resources(self):
        return [("container", self.tunnel), ("container", self.app),
                ("volume", self.volume), ("network", self.network)]

    def diagnostics(self):
        # Only aggregate error/state fields. Never actors, event IDs, content, URLs or keys.
        result = {}
        try:
            result["deliveries"] = self.node(
                "const {DatabaseSync}=require('node:sqlite');"
                "const d=new DatabaseSync('/data/bookface.sqlite',{readOnly:true});"
                "console.log(JSON.stringify(d.prepare('SELECT kind,state,attempts,last_status,"
                "COUNT(*) AS count FROM federation_deliveries GROUP BY kind,state,attempts,"
                "last_status').all()))"
            )
        except Failure as caught:
            result["queueCode"] = caught.code
        logs = docker(["logs", self.tunnel], checked=False)
        result["tunnelRegistered"] = b"Registered tunnel connection" in logs.stdout + logs.stderr
        return result

    def cleanup(self):
        owned = set(self.created)
        proof = []
        for kind, name in self.resources():
            if (kind, name) not in owned:
                continue
            try:
                if name not in inventory(kind):
                    proof.append(True)
                    continue
                inspected = docker([kind, "inspect", name], checked=False)
                if inspected.returncode:
                    proof.append(False)
                    continue
                obj = json.loads(inspected.stdout)[0]
                labels = (obj.get("Config", {}).get("Labels") if kind == "container"
                          else obj.get("Labels")) or {}
                if labels.get("qualification") != self.prefix:
                    proof.append(False)
                    continue
                args = ["rm", "-f", name] if kind == "container" else [kind, "rm", name]
                docker(args, checked=False)
                # A failed inspect is never absence proof: inventory must succeed.
                proof.append(name not in inventory(kind))
            except (Failure, ValueError, UnicodeError):
                proof.append(False)
        return len(proof) == len(owned) and all(proof)


def setup_user(origin, name, token):
    password = secrets.token_urlsafe(28)
    mask(password)
    response = http(origin, "/actions/setup", data={
        "setupToken": token, "username": name, "displayName": name.title() + " Example",
        "password": password, "acceptRules": "true",
    })
    data = decode(response, "SETUP_" + name.upper())
    return {"origin": origin, "name": name, "password": password,
            "cookie": response[2].get("set-cookie", "").split(";")[0],
            "csrf": data["csrf"], "actor": origin + "/users/" + name}


def register_stranger(owner):
    invitation = decode(api(owner, "/actions/invites", {"kind": "registration"}), "INVITE")
    response = http(owner["origin"], "/actions/register", data={
        "inviteToken": invitation["token"], "username": "charlie",
        "displayName": "Charlie Example", "password": secrets.token_urlsafe(28),
        "acceptRules": "true",
    })
    data = decode(response, "REGISTER_STRANGER")
    return {"origin": owner["origin"], "cookie": response[2].get("set-cookie", "").split(";")[0],
            "csrf": data["csrf"]}


def archive_zip(path, marker, fixture):
    rows = [{"id": marker, "timestamp": 946684800, "data": [{"post": marker}],
             "attachments": [{"data": [{"media": {"uri": "photos/synthetic.png"}}]}]}]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json",
            json.dumps(rows),
        )
        archive.writestr("photos/synthetic.png", fixture)


def imported_item(user, marker):
    items = decode(api(user, "/api/archive"), "ARCHIVE_READ")["items"]
    return next((item for item in items if item.get("body") == marker), None)


def post_path(origin, post_id):
    return "/api/posts/" + parse.quote(origin + "/federation/objects/" + post_id, safe="")


class DeliveryRows(HTMLParser):
    """Read only the existing user-visible receipt table; no hidden admin API."""

    def __init__(self):
        super().__init__()
        self.rows = []
        self.cells = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.cells = []
        elif tag == "td" and self.cells is not None:
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append("\n")

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag == "td" and self.cell is not None:
            self.cells.append("".join(self.cell))
            self.cell = None
        elif tag == "tr" and self.cells is not None:
            if len(self.cells) == 3:
                self.rows.append({"kind": self.cells[0].splitlines()[0].strip(),
                                  "recipient": self.cells[1].strip(),
                                  "status": self.cells[2].strip()})
            self.cells = None


def post_delivery_rows(user, recipient):
    response = expect_status(api(user, "/sharing"), 200, "DELIVERY_RECEIPTS")
    parser = DeliveryRows()
    parser.feed(response[1].decode("utf-8"))
    return [row for row in parser.rows
            if row["kind"] == "post.create" and row["recipient"] == recipient]


def journey(lab, remote_origin, remote_token, browser, directory, fixture, step):
    token = docker(["exec", lab.app, "cat", "/data/.setup-token"]).stdout.decode().strip()
    alice = setup_user(lab.origin, "alice", token)
    bob = setup_user(remote_origin, "bob", remote_token)
    charlie = register_stranger(bob)
    step("fictional_accounts_created")

    for user in [alice, bob]:
        marker = "Fictional private memory " + user["name"] + " " + lab.prefix
        archive_path = directory / (user["name"] + "-synthetic.zip")
        archive_zip(archive_path, marker, fixture)
        browser.call(action="login_import", name=user["name"], origin=user["origin"],
                     password=user["password"], zipPath=str(archive_path))
        item = wait_for(lambda: imported_item(user, marker), "PRIVATE_IMPORT", 180)
        require(bool(item.get("mediaIds")), "IMPORTED_PRIVATE_MEDIA_MISSING")
        user["importedItem"] = item
        browser.call(action="observe", name=user["name"], origin=user["origin"],
                     path="/archive/" + item["id"], status=200, text=marker, privateImage=True)
        feed = decode(api(user, "/api/feed"), "PRIVATE_IMPORT_FEED")
        require(not any(post.get("body") == marker for post in feed["posts"]), "IMPORT_AUTO_SHARED")
        media_path = "/media/" + item["mediaIds"][0]
        expect_status(api(user, media_path), 200, "PRIVATE_MEDIA_OWNER")
        expect_status(http(user["origin"], media_path), 401, "PRIVATE_MEDIA_ANONYMOUS")
        if user is bob:
            expect_status(api(charlie, "/archive/" + item["id"]), 404, "PRIVATE_ARCHIVE_STRANGER")
            expect_status(api(charlie, media_path), 404, "PRIVATE_MEDIA_STRANGER")
        step(user["name"] + "_browser_import_private_media_verified")

    decode(api(bob, "/actions/friends/request", {"actor": alice["actor"]}), "FRIEND_REQUEST")

    def pending_friend():
        response = expect_status(api(alice, "/friends"), 200, "FRIEND_LIST")
        match = re.search(rb'/actions/friends/([^"/]+)/accept', response[1])
        return match.group(1).decode() if match else None

    friend_id = wait_for(pending_friend, "FRIEND_INCOMING", 300)
    decode(api(alice, "/actions/friends/" + friend_id + "/accept", {}), "FRIEND_ACCEPT")
    # Observe reciprocal acceptance in Bob's own rendered friends page.
    wait_for(lambda: b"Friends \xc2\xb7 1" in api(bob, "/friends")[1], "FRIEND_RECIPROCAL", 300)
    step("cross_host_mutual_friendship")

    imported = alice["importedItem"]
    prepared = decode(api(alice, "/actions/archive/" + imported["id"] + "/prepare", {
        "selectionPresent": "true", "mediaIds": imported["mediaIds"],
    }),
                      "IMPORTED_MEMORY_PREPARE")
    require(bool(prepared.get("mediaIds")), "IMPORTED_SHARE_MEDIA_MISSING")
    media_id = prepared["mediaIds"][0]
    caption = "A fictional photo selected for one friend."
    post = decode(api(alice, "/actions/posts", {
        "body": caption, "audience": "selected", "recipientActors": [bob["actor"]],
        "mediaIds": prepared["mediaIds"], "archiveSourceId": imported["id"],
    }), "SELECTED_SHARE")["post"]
    remote_path = post_path(alice["origin"], post["id"])
    wait_for(lambda: api(bob, remote_path)[0] == 200, "SELECTED_DELIVERY", 300)
    remote_object = alice["origin"] + "/federation/objects/" + post["id"]
    media_url = alice["origin"] + "/federation/media/" + media_id
    page_path = "/posts/" + parse.quote(remote_object, safe="")
    proxy_path = page_path + "/media/" + parse.quote(media_url, safe="")
    browser.call(action="observe", name="bob", origin=bob["origin"], path=page_path,
                 status=200, text=caption)
    photo = expect_status(api(bob, proxy_path), 200, "REMOTE_PHOTO")
    require(photo[1][:4] == b"RIFF" and photo[1][8:12] == b"WEBP", "REMOTE_PHOTO_BYTES")
    expect_status(api(charlie, remote_path), 404, "SELECTED_STRANGER")
    expect_status(api(charlie, proxy_path), 404, "PHOTO_STRANGER")
    expect_status(http(bob["origin"], proxy_path), 401, "PHOTO_ANONYMOUS")
    expect_status(http(alice["origin"], "/federation/objects/" + post["id"]), 403,
                  "OBJECT_UNSIGNED")
    action_path = "/actions/posts/" + parse.quote(remote_object, safe="")
    expect_status(api(charlie, action_path + "/comment", {"body": "Unauthorized"}), 404,
                  "COMMENT_STRANGER")
    decode(api(bob, action_path + "/comment", {"body": "A fictional remote reply."}), "COMMENT_SEND")
    wait_for(lambda: len(decode(api(alice, "/api/posts/" + post["id"]),
                               "COMMENT_READ")["post"]["comments"]) == 1,
             "COMMENT_DELIVERY", 300)
    step("selected_photo_comment_and_unauthorized_denials")

    # Existing DOM exposes kind/recipient/status, not object IDs. This fresh sender
    # has never published a post to Alice; require exactly one new matching row.
    require(not post_delivery_rows(bob, alice["actor"]), "OFFLINE_RECEIPT_BASELINE_NOT_EMPTY")
    docker(["stop", "--time", "20", lab.app])
    try:
        outage_status = http(alice["origin"], "/healthz")[0]
        require(500 <= outage_status <= 599, "OFFLINE_PUBLIC_STATUS")
    except Failure as caught:
        if caught.code not in {"HTTP_TIMEOUT", "HTTP_TRANSPORT", "HTTP_DNS", "HTTP_TLS"}:
            raise
    offline = decode(api(bob, "/actions/posts", {
        "body": "A fictional post queued while the receiver is offline.",
        "audience": "selected", "recipientActors": [alice["actor"]],
    }), "OFFLINE_QUEUE")["post"]
    # Read the sender's actual user-visible ledger; do not infer a retry from sleep.
    # Never alter delivery schedules or acknowledge jobs by hand.
    def exact_new_post_waiting():
        rows = post_delivery_rows(bob, alice["actor"])
        require(len(rows) <= 1, "OFFLINE_RECEIPT_AMBIGUOUS")
        return len(rows) == 1 and rows[0]["status"] == "Waiting to retry"

    wait_for(exact_new_post_waiting, "OFFLINE_RETRY_RECEIPT", 90)
    browser.call(action="observe", name="bob", origin=bob["origin"], path="/sharing",
                 status=200, text="Waiting to retry")
    docker(["start", lab.app])
    wait_for(lambda: http(alice["origin"], "/healthz")[0] == 200, "RESTART_READY", 90)
    wait_for(lambda: api(alice, post_path(bob["origin"], offline["id"]))[0] == 200,
             "OFFLINE_RETRY_DELIVERY", 300)
    browser.call(action="observe", name="alice", origin=alice["origin"],
                 path="/posts/" + parse.quote(bob["origin"] + "/federation/objects/" + offline["id"], safe=""),
                 status=200, text=offline["body"])
    wait_for(lambda: len(post_delivery_rows(bob, alice["actor"])) == 1
             and post_delivery_rows(bob, alice["actor"])[0]["status"] == "Received",
             "OFFLINE_RETRY_ACKNOWLEDGED", 90)
    step("own_receiver_offline_restart_and_unique_post_retry")

    decode(api(alice, "/actions/posts/" + post["id"] + "/revoke", {"actor": bob["actor"]}),
           "REVOKE_SEND")
    wait_for(lambda: api(bob, remote_path)[0] == 404, "REVOKE_DELIVERY", 300)
    expect_status(api(bob, proxy_path), 404, "REVOKED_PHOTO")
    browser.call(action="observe", name="bob", origin=bob["origin"], path=page_path, status=404)
    step("remote_revocation_and_photo_denial")

    second = decode(api(alice, "/actions/posts", {
        "body": "A fictional object deliberately deleted.", "audience": "selected",
        "recipientActors": [bob["actor"]], "archiveSourceId": imported["id"],
        "mediaIds": prepared["mediaIds"],
    }), "DELETE_TARGET")["post"]
    second_path = post_path(alice["origin"], second["id"])
    wait_for(lambda: api(bob, second_path)[0] == 200, "DELETE_TARGET_DELIVERY", 300)
    decode(api(alice, "/actions/posts/" + second["id"] + "/delete", {}), "DELETE_SEND")
    wait_for(lambda: api(bob, second_path)[0] == 404, "DELETE_DELIVERY", 300)
    browser.call(action="observe", name="bob", origin=bob["origin"],
                 path="/posts/" + parse.quote(alice["origin"] + "/federation/objects/" + second["id"], safe=""),
                 status=404)
    decode(api(alice, "/actions/posts/" + post["id"] + "/delete", {}),
           "IMPORTED_PUBLICATION_DELETE")
    expect_status(api(alice, "/api/posts/" + post["id"]), 404, "IMPORTED_PUBLICATION_GONE")
    expect_status(api(bob, remote_path), 404, "IMPORTED_PUBLICATION_REMOTE_GONE")
    # Deleting the publication must not delete the owner's private imported original.
    expect_status(api(alice, "/archive/" + imported["id"]), 200, "PRIVATE_ORIGINAL_RETAINED")
    step("remote_deletion_observed_in_fresh_browser")


def workflow_scope():
    require(os.environ.get("GITHUB_ACTIONS") == "true", "GITHUB_RUNNER_REQUIRED")
    require(os.environ.get("GITHUB_REPOSITORY") == "Dynobit/clean-bookface", "REPOSITORY_SCOPE")
    require(os.environ.get("GITHUB_REF") == "refs/heads/main", "MAIN_REQUIRED")
    require(os.environ.get("QUALIFICATION_REPOSITORY_PRIVATE") == "true", "PRIVATE_REQUIRED")
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(run.isdigit() and attempt.isdigit(), "RUN_ID_INVALID")
    return "cbqual-" + run + "-" + attempt


def validate_environment():
    prefix = workflow_scope()
    origin = os.environ.get("PEER_ORIGIN", "")
    token = os.environ.get("PEER_SETUP_TOKEN", "")
    require(bool(re.fullmatch(r"https://[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com", origin)),
            "PEER_ORIGIN_INVALID")
    require(bool(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token)), "PEER_TOKEN_INVALID")
    fixture = FIXTURE.read_bytes()
    require(hashlib.sha256(fixture).hexdigest() == FIXTURE_SHA256, "SYNTHETIC_FIXTURE_HASH")
    mask(origin)
    mask(token)
    return origin, token, fixture, prefix


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup-only", action="store_true",
                        help="Verify labels and remove only this runner's exact resources")
    options = parser.parse_args()
    if options.cleanup_only:
        try:
            lab = Lab(workflow_scope())
            lab.created = lab.resources()
            cleaned = lab.cleanup()
            print(json.dumps({"cleanup": cleaned}), flush=True)
            return 0 if cleaned else 1
        except Failure as caught:
            print(json.dumps({"cleanup": False, "failureCode": caught.code}), flush=True)
            return 1
    receipt = {"schema": 1, "coverage": "browser-assisted API; not all-UI usability",
               "checks": [], "startedAt": int(time.time())}
    lab = None
    browser = None

    def interrupted(signum, frame):
        raise Failure("INTERRUPTED")

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)

    def step(name):
        receipt["checks"].append({"name": name, "passed": True})
        print("PASS " + name, flush=True)

    try:
        origin, token, fixture, prefix = validate_environment()
        lab = Lab(prefix)
        lab.start()
        receipt["runnerImageId"] = json.loads(docker(["image", "inspect", APP_IMAGE]).stdout)[0]["Id"]
        receipt["sourceCommit"] = os.environ.get("GITHUB_SHA")
        ready_started = time.monotonic()
        for endpoint in [lab.origin, origin]:
            wait_for(lambda: http(endpoint, "/healthz")[0] == 200, "PUBLIC_READY", 600)
        receipt["readinessSeconds"] = round(time.monotonic() - ready_started, 2)
        require(lab.origin != origin, "INDEPENDENT_ORIGINS")
        step("two_public_origins_and_runner_hardening")
        browser = Browser()
        with tempfile.TemporaryDirectory(prefix="cbqual-fictional-") as directory:
            journey(lab, origin, token, browser, Path(directory), fixture, step)
        receipt["result"] = "pass"
    except Failure as caught:
        receipt.update(result="fail", failureCode=caught.code, httpStatus=caught.status)
    except Exception:
        # Unexpected failures also fail the job without dumping credentials or HTTP bodies.
        receipt.update(result="fail", failureCode="HARNESS_UNEXPECTED")
    finally:
        if lab:
            receipt["safeDiagnostics"] = lab.diagnostics()
        if browser:
            try:
                browser.close()
            except Exception:
                receipt.update(result="fail", browserCleanup=False)
        receipt["cleanup"] = lab.cleanup() if lab else True
        if lab and lab.origin:
            try:
                receipt["temporaryOriginStopped"] = http(lab.origin, "/healthz")[0] != 200
            except Failure:
                receipt["temporaryOriginStopped"] = True
        receipt["finishedAt"] = int(time.time())
        print(json.dumps(receipt, sort_keys=True), flush=True)
    return 0 if receipt.get("result") == "pass" and receipt["cleanup"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
