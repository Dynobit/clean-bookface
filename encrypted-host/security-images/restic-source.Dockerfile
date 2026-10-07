FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS compiler
COPY go1.26.8.linux-arm64.tar.gz /tmp/go.tar.gz
RUN tar -xzf /tmp/go.tar.gz -C /usr/local && rm /tmp/go.tar.gz
ENV PATH=/usr/local/go/bin:$PATH CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOENV=off GOFLAGS=-mod=vendor
WORKDIR /source
COPY source/ ./
RUN go build -trimpath -buildvcs=false -tags 'selfupdate disable_grpc_modules' -ldflags '-s -w' -o /restic ./cmd/restic

FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510
COPY *.apk /tmp/security-packages/
RUN apk --no-network verify /tmp/security-packages/*.apk && apk --no-network add /tmp/security-packages/*.apk && rm -rf /tmp/security-packages
COPY --from=compiler /restic /usr/bin/restic
LABEL org.opencontainers.image.title="Clean Bookface Restic security build" org.cleanbookface.ownership="project-derived-not-official" org.cleanbookface.upstream-commit="6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf"
