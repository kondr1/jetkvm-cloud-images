# syntax=docker/dockerfile:1
#
# jetkvm/cloud-api on Bun instead of node + ts-node.
# Build context: jetkvm/cloud-api at the ref in upstream.env with api/patches applied, e.g.
#   docker buildx build -f api/Dockerfile upstream/cloud-api

FROM oven/bun:1.4.4-slim
LABEL org.opencontainers.image.source="https://github.com/kondr1/jetkvm-cloud-images"
LABEL org.opencontainers.image.description="JetKVM cloud-api running on Bun; migrate with: bun --bun x prisma migrate deploy"
LABEL org.opencontainers.image.licenses="GPL-2.0"
WORKDIR /app

# Prisma's query engine needs OpenSSL at runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
# Bun migrates package-lock.json, so versions match upstream's lockfile
RUN bun install --production
COPY src ./src
# --bun: the Prisma CLI's shebang asks for node, which this image does not have
RUN bun --bun x prisma generate

ENV NODE_ENV=production
ENV PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "--smol", "src/index.ts"]
