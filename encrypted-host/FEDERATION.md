# Optional friendships between independent homes

Federation is off unless the host supplies `--federation-peer`. Two independent homes have different permanent Matrix server names and signing identities. They are distinct from a primary and standby, which share an identity and must never run simultaneously.

For a new home, explicitly name each peer's **Matrix server identity**, not its delegated web endpoint:

```sh
python3 encrypted-host/host.py bootstrap --mode production \
  --runtime /srv/home-a --server-name home-a.example \
  --public-url https://matrix.home-a.example \
  --federation-peer home-b.example
```

Home B must reciprocally configure `--federation-peer home-a.example`. Repeat the flag for additional peers. `https://home-b.example` is accepted as an origin-shaped spelling of the same identity; paths, wildcards, credentials, IP literals and HTTP origins are rejected. An explicit port is part of a Matrix identity and is preserved; `home-b.example` and `home-b.example:8448` are different identities. Do not pass `matrix.home-b.example` unless that is actually the peer's identity. The setting is not a client-side restriction and does not create a friendship or share keys.

The generated Synapse config includes `client` and `federation` resources on its loopback-published HTTP listener, an exact `federation_domain_whitelist`, and no third-party trusted key server. No peer flag means an empty whitelist and only the client listener. Public room publication/directory access, guests, previews and identity lookup remain disabled. Synapse's default private/reserved IP protections and federation certificate validation remain intact. This application-layer peer restriction is not a network firewall; unauthenticated version/key discovery may remain accessible. Room membership and encryption still decide who can receive or read content.

## HTTPS discovery and routing

`operations.py prepare-https` now generates the restricted proxy and discovery responses from the explicit peer configuration:

```sh
python3 encrypted-host/operations.py prepare-https --runtime /srv/home-a \
  --client-url https://client.example
python3 encrypted-host/operations.py validate-https --runtime /srv/home-a
python3 encrypted-host/host.py start --runtime /srv/home-a
```

Use the [explicit loopback tunnel mode](SELF_HOST.md#optional-existing-tls-tunnel) when another service terminates public TLS. Preparation refuses mismatches between the recorded peers, Synapse whitelist/listener and client identity. It does not add peers, create DNS records, publish the independent client or qualify a live public route. It serves exactly the discovery response below at the permanent identity hostname and forwards federation/key paths only when the peer list is nonempty. Synapse verifies signed peer identity; the proxy does not treat an untrusted HTTP header or source address as peer authorization.

1. Keep the permanent identity `home-a.example` under the host's control. Serve `https://home-a.example/.well-known/matrix/server` on port 443 with a valid certificate and HTTP 200 JSON:

   ```json
   {"m.server":"matrix.home-a.example:443"}
   ```

   For a single hostname, self-delegate instead with `{"m.server":"home-a.example:443"}`. This makes the intended HTTPS port explicit rather than relying on port 8448 or SRV discovery. Serve `Content-Type: application/json`; use a short cache lifetime while qualifying changes. `/.well-known/server` alone is **not** the Matrix discovery path.

2. At `matrix.home-a.example:443`, terminate publicly trusted TLS for that exact hostname. Forward `/_matrix/client/`, `/_matrix/media/`, `/_matrix/federation/` and `/_matrix/key/` to this home's published loopback port (default 18008, container port 8008). Preserve the raw path/query, HTTP methods, authorization headers and request bodies. Authenticated remote media uses the federation routes. Replace forwarded-IP headers; never trust incoming client values. Do not expose `/_synapse/admin/` or files from the runtime directory. Set upload/body and timeout limits deliberately.

3. Configure the other home equivalently. Each allowlist contains the other **original identity**, even when discovery delegates to a different hostname. Retain certificate and hostname verification. Do not make private-address exceptions or disable TLS verification to repair production discovery.

4. Check discovery, key discovery, reciprocal invitations, encrypted-room join, encrypted event delivery and authenticated encrypted-media retrieval from the actual homes. Test denial from a non-allowlisted home. Then qualify the independent trusted browser client: identity verification, key exchange, decryption, excluded recipients and recovery. Passing the protocol fixture below does not qualify that browser flow or a production installation.

Hosts see remote account identifiers, delivery relationships, room membership, addresses, timing and sizes. Choose peers deliberately, agree on invitation/abuse/retention practices, and protect the proxy and service with appropriate inbound limits. Revoking a peer prevents future federation but does not erase previously received events or media. Do not revoke a healthy peer through unreviewed shared-tree edits; changing an existing installation requires a reviewed config change, backup/rollback and targeted service restart.

## Disposable two-home protocol fixture

```sh
python3 encrypted-host/qualify_federation.py --runtime /tmp/federation-proof
```

Requires the cached official ARM64 image digests recorded in `imported-images.json`, Docker Compose and OpenSSL. It creates two independent homes with unique per-run server names on loopback ports 18030/18031 and a private fixture Docker network. No existing endpoint or project is changed. Generated fictional accounts, credentials, CA key, certificates and runtime data stay outside Git. No CA is installed on the Mac. TLS remains verified using a fresh CA trusted only by the two disposable Synapse containers. Exact fixture peer `/32` addresses are the only private-address exceptions, written by the fixture itself; `host.py` has no option to introduce those exceptions in production.

The fixture tests closed-default federation, an actual rejected remote invite while the receiver's allowlist is empty, then reciprocal allowlisting, invite/join, encryption state, exact opaque `m.room.encrypted` delivery and authenticated remote-media retrieval. Its randomly generated opaque content is intentionally not claimed to be client-encrypted Megolm or media. It writes `qualification.json` privately, including checks and failures. It removes its own containers, volumes and network by default, retaining private runtime evidence. `--keep-running` retains passing fixtures for a separate browser test. To clean up those retained fixtures, run `host.py destroy-local` for each of `RUNTIME/a` and `RUNTIME/b`, then remove the exact network recorded in `RUNTIME/fixture-network.json`. Do not use these test identities or private CA for members.

By default the fixture uses verified TLS on port 8448 and direct server discovery. Add `--https-proxy` to exercise the generated Caddy proxy, verified HTTPS `/.well-known/matrix/server` delegation to a separate storage hostname on 443, and the same signed invite/join/event/media flow through that proxy. Docker-only DNS aliases and a private fixture CA remain isolated to these containers. Public DNS, ACME issuance/renewal, independent failure domains and production network admission remain separate deployment checks.

References: [Synapse federation configuration](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#federation_domain_whitelist), [reverse proxy](https://element-hq.github.io/synapse/latest/reverse_proxy.html), [delegation](https://element-hq.github.io/synapse/latest/delegate.html).
