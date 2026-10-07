FROM caddy:2.11.7-alpine@sha256:84058f1a0e5beb97664a9b79dcfd267b594c033d5bb88d8463cdfb59c0779197
COPY *.apk /tmp/security-packages/
RUN apk --no-network verify /tmp/security-packages/*.apk && apk --no-network add /tmp/security-packages/*.apk && rm -rf /tmp/security-packages
