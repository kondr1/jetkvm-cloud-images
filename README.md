# jetkvm-cloud-images

Container images for a self-hosted [JetKVM](https://jetkvm.com) Cloud, built from the
upstream sources pinned in [`upstream.env`](upstream.env).

| Image | What it is |
|---|---|
| `ghcr.io/kondr1/jetkvm-cloud-api` | [jetkvm/cloud-api](https://github.com/jetkvm/cloud-api) running on **Bun** instead of node + ts-node, with [small patches](api/patches) |
| `ghcr.io/kondr1/jetkvm-cloud-ui` | the cloud UI from [jetkvm/kvm](https://github.com/jetkvm/kvm/tree/main/ui), embedded in a [tiny Go server](ui/server) on `scratch` |

Tags: `latest`, `sha-<this repo>`, `upstream-<upstream commit>`.

## cloud-api

Same environment as upstream's [`.env.example`](https://github.com/jetkvm/cloud-api/blob/main/.env.example), plus:

| Variable | Meaning |
|---|---|
| `TURN_SECRET`, `TURN_URLS` | Self-hosted coturn (`use-auth-secret`). `/webrtc/ice_config` returns one-hour credentials for the comma-separated `TURN_URLS` instead of calling Cloudflare. |
| `OIDC_ISSUER`, `OIDC_JWKS_URL` | Default to Google. Only the e2e tests change them, to point at a mock provider. |

Without `TURN_*` and `CLOUDFLARE_TURN_*`, `/webrtc/ice_config` falls back to the STUN servers from `ICE_SERVERS`.
Without `R2_ENDPOINT`, the release sync is not scheduled.

Run migrations with the same image before starting it:

```sh
docker run --rm -e DATABASE_URL=... ghcr.io/kondr1/jetkvm-cloud-api bun --bun x prisma migrate deploy
```

## cloud-ui

The UI is built with a placeholder API origin, which the server replaces at startup:

```sh
docker run -e JETKVM_CLOUD_API=https://api.example.com -p 8080:8080 ghcr.io/kondr1/jetkvm-cloud-ui
```

Hashed assets are served as immutable, unknown paths without an extension fall back to `index.html`.

## Tests

CI builds both images and, before pushing anything, runs:

- `ui/server` unit tests and a smoke test of the built UI image;
- upstream's own test suite on the patched sources;
- [`tests/e2e`](tests/e2e): the full flow against Postgres, coturn and a mock OIDC provider: login, allowlist,
  device adoption, device and client WebSocket signaling, TURN credentials checked by coturn itself.
  It runs against the Bun image and against upstream's node image, and reports the memory use of both
  in the job summary.

## Updating upstream

Bump the refs in `upstream.env`. If a patch no longer applies, CI fails at "Apply patches".

## License

GPL-2.0, like the upstream projects.

## Tailscale with AmneziaWG for the JetKVM

The [`tailscale-awg`](.github/workflows/tailscale-awg.yml) workflow builds the
[Tailscale fork with AmneziaWG/QUIC transports](https://github.com/LiuTangLei/tailscale) (pinned in `upstream.env`)
for the JetKVM's linux/armv7 as one binary that is both `tailscaled` and `tailscale`, and publishes it as a release
with an installer. On the device (developer mode shell):

```sh
wget -qO- https://github.com/kondr1/jetkvm-cloud-images/releases/download/tailscale-awg-v1.104.2-jetkvm/install-jetkvm.sh | sh
```

It installs into `/userdata/tailscale` (kept across firmware updates) with `/userdata/init.d/S30tailscale`, which
starts `tailscaled` on boot and links `/usr/bin/tailscale` so the firmware's Tailscale settings page finds it.
