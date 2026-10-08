# Devnet merchant for testing deployed LanaTools: the testbed's merchant.yaml
# behind `pay gate api` and a loopback fixture server. Build context: packages/testbed.
# pay's x86_64 build needs glibc 2.39+, newer than bookworm's.
FROM oven/bun:1.4.2 AS bun
FROM debian:trixie-slim

# pay 0.29's gateway rejects Pay Kit 0.12 MPP credentials ("Challenge ID
# mismatch"); 0.28 accepts both MPP and x402. Recheck before upgrading.
ARG PAY_VERSION=0.28.0
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
# Pinned release, verified against its published sha256sums.txt.
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) target=x86_64-unknown-linux-gnu; sum=f337be40aebf5d944d2874707a8ecc8050be44aba2cf905cee883c0c472f68d5 ;; \
    arm64) target=aarch64-unknown-linux-gnu; sum=31a8f6425d75c4b8687b517e86c35c2e19405d388792b69440436ebb7166db93 ;; \
    *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/pay.tgz "https://github.com/solana-foundation/pay/releases/download/pay-v${PAY_VERSION}/pay-${target}.tar.gz"; \
  echo "$sum  /tmp/pay.tgz" | sha256sum -c -; \
  tar xzf /tmp/pay.tgz -C /usr/local/bin pay; \
  rm /tmp/pay.tgz; \
  pay --version

COPY merchant.yaml /app/merchant.yaml
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY src/merchant-server.ts /app/src/merchant-server.ts
COPY gateway/entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
