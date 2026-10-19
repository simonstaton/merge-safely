# syntax=docker/dockerfile:1.6
# Merge Safely self-hosted GitHub App. Build from the repository root:
#   docker build -f packages/app/Dockerfile -t merge-safely-app .
# The root .dockerignore (honoured by every builder) and packages/app/Dockerfile.dockerignore (BuildKit) keep
# node_modules, build output, .env files and *.pem keys out of the context. The runtime stage additionally copies
# only each package's package.json and dist/, never sources or anything else that was in the context.

FROM node:20-slim AS build
WORKDIR /src
# Toolchain only for the rare platform without a better-sqlite3 prebuild.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev \
  && mkdir /out \
  && for d in packages/*/; do \
       mkdir -p "/out/$d" && cp "$d/package.json" "/out/$d/" && if [ -d "$d/dist" ]; then cp -r "$d/dist" "/out/$d/"; fi; \
     done

FROM node:20-slim AS runtime
# git: reviewers get a disposable checkout of the head SHA. ripgrep: faster read-only search tool.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    MERGE_SAFELY_DATA_DIR=/data \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=root:root /src/package.json /src/package-lock.json ./
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /out/packages ./packages
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
# Runs as the image's `node` user (uid 1000): a mounted key file must be readable by uid 1000.
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# tini forwards SIGTERM so in-flight reviews get their graceful-shutdown window.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/app/dist/main.js"]
