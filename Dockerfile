FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS backup-tool
FROM node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --maxsockets=5 --fetch-retries=2 --fetch-timeout=90000
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212
COPY --from=backup-tool /usr/bin/restic /usr/local/bin/restic
COPY --from=backup-tool /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node provider-start.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /data /home/node/.ssh && chown node:node /data /home/node/.ssh && chmod 700 /data /home/node/.ssh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT || '3000') +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","provider-start.mjs","server"]
