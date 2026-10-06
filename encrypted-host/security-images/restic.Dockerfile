FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510
COPY *.apk /tmp/security-packages/
RUN apk --no-network verify /tmp/security-packages/*.apk && apk --no-network add /tmp/security-packages/*.apk && rm -rf /tmp/security-packages
