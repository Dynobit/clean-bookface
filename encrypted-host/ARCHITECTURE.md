# Host architecture support

The supported installation target for this release is **Linux ARM64** (`aarch64` hardware, Docker server architecture `arm64`). It has been exercised on separate physical ARM64 Linux machines, including root-run installation, real systemd scheduling, separate-host SFTP backup and fenced restoration. ARM64 Docker Desktop supplies additional isolated browser/protocol fixtures; it is not the production Linux scheduler.

Check the **Docker server**, which may differ from the machine running its CLI:

```sh
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
```

Choose a Linux ARM64 server or ARM64 VPS image with Docker Engine, Compose, Python 3 and systemd. A dedicated server is simplest; existing services and required ports must be inventoried before installation. The hosting guide does not provision a provider account or promise a provider's availability or price. Size memory and storage from the intended member/media volume, and leave room for consistent backup staging plus retained snapshots. Current fixture timings are not a production capacity estimate.

`images.json` pins the reviewed Synapse/PostgreSQL images. `imported-images.json` is restricted to disposable local qualification after verified Docker save/load representation conversion; it is not permission to substitute arbitrary tags. Caddy and restic are also digest-pinned in their consuming code. Preserve these locks through deployment and qualify any replacement release before admitting it.

**AMD64/x86 VPS support is not qualified by this release.** Official upstream manifests advertise AMD64 builds, and the Synapse 1.162.0 AMD64 manifest was independently observed during this work. That availability does not establish that this exact installation/backup/restore set works on AMD64. Do not relabel an ARM64 digest, rely on implicit emulation or remove digest checks to deploy there. A future AMD64 release needs a reviewed complete lock set, explicit platform selection and the same installation, invitation, TLS, backup, scheduler and restore acceptance on that platform. No AMD64 machine or paid resource was provisioned for this release.

References: [official Synapse installation/images](https://element-hq.github.io/synapse/latest/setup/installation.html), [Docker manifest inspection](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/).
