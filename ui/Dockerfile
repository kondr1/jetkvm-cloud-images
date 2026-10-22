# syntax=docker/dockerfile:1
#
# Cloud UI from jetkvm/kvm, served by a small Go binary with the build embedded.
# Build with the UI sources as a named context:
#   docker buildx build --build-context kvm-ui=upstream/kvm/ui ui/

FROM node:22.23.4-bookworm-slim AS web
WORKDIR /ui
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=kvm-ui package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --from=kvm-ui . .
# Process env beats .env.cloud-production; the server swaps the placeholder for JETKVM_CLOUD_API at startup.
RUN VITE_CLOUD_API=__JETKVM_CLOUD_API__ npm run build:prod

FROM golang:1.27.3-alpine AS server
WORKDIR /src
COPY server/ ./
RUN rm -rf dist
COPY --from=web /ui/dist ./dist
RUN go vet ./... && go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /jetkvm-cloud-ui .

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/kondr1/jetkvm-cloud-images"
LABEL org.opencontainers.image.description="JetKVM cloud UI; set JETKVM_CLOUD_API to the cloud-api origin"
LABEL org.opencontainers.image.licenses="GPL-2.0"
COPY --from=server /jetkvm-cloud-ui /jetkvm-cloud-ui
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["/jetkvm-cloud-ui", "-healthcheck"]
ENTRYPOINT ["/jetkvm-cloud-ui"]
