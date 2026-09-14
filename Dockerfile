# Build with BuildKit (Docker >= 23 default, or `docker buildx build`) or Podman/Buildah:
# needs TARGETARCH and RUN --mount cache support.

# ---- build: pnpm (checksum-verified), deps, tsc, production deploy into /out ----
FROM docker.io/library/node:24-trixie-slim@sha256:6950b66b4c0cb0151ce89fa75074673850763d096b044f422c6729b588dd4956 AS build

# Keep PNPM_VERSION equal to the pnpm version in mise.toml. When bumping, take the checksums from
# `gh release view v<version> --repo pnpm/pnpm --json assets` (the `digest` of
# pnpm-linux-x64.tar.gz and pnpm-linux-arm64.tar.gz).
ARG PNPM_VERSION=12.4.1
ARG PNPM_SHA256_AMD64=66e9886299085dade56e203ae0e3586f35787f8801a68d33ec07ac17b0de2001
ARG PNPM_SHA256_ARM64=14f7a3e67d658d4ca8002c2aa0567f27dc5fe056a9f29f98ba7d2bfd6c81591b
ARG TARGETARCH

# `set -eu` instead of SHELL: Podman's default OCI image format ignores SHELL.
# node:*-slim has no curl/wget, so Node's built-in fetch downloads the tarball.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) PNPM_ARCH=x64;   PNPM_SHA256="${PNPM_SHA256_AMD64}" ;; \
      arm64) PNPM_ARCH=arm64; PNPM_SHA256="${PNPM_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${PNPM_ARCH}.tar.gz"; \
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status} for ${process.argv[1]}`); require("node:fs").writeFileSync("/tmp/pnpm.tar.gz", Buffer.from(await r.arrayBuffer())); })' "${url}"; \
    echo "${PNPM_SHA256}  /tmp/pnpm.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/pnpm; \
    tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm; \
    rm /tmp/pnpm.tar.gz; \
    ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm; \
    pnpm --version

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.build.json

# pnpm 12 deploys a single (non-workspace) project without --legacy.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm deploy --prod --store-dir /pnpm-store /out \
    && test -f /out/dist/cli.js \
    && test -d /out/node_modules/@actual-app/api

# ---- runtime: compiled JS + production node_modules only, owned by root, run as node ----
FROM docker.io/library/node:24-trixie-slim@sha256:6950b66b4c0cb0151ce89fa75074673850763d096b044f422c6729b588dd4956 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app

USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["sync"]
