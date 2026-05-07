# ============================================================
# Agent Communication Hub — Dockerfile
# ============================================================
# Build:  docker build -t liuboacean/agent-comm-hub .
# Run:    docker run -d -p 3100:3100 --name ach liuboacean/agent-comm-hub
# Health: docker inspect --format='{{.State.Health.Status}}' ach
# ============================================================

# ── Stage 1: Build native bindings ──────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache \
        python3 \
        make \
        g++ \
        python3-dev \
        musl-dev

# Install npm deps (including devDeps for build)
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Rebuild better-sqlite3 for the final target
RUN npm rebuild better-sqlite3


# ── Stage 2: Production runtime ─────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Runtime dependencies only — minimal attack surface
RUN apk add --no-cache \
        wget \
        ca-certificates \
        tzdata

# Create non-root user for security
RUN addgroup -g 1001 -S ach && \
    adduser  -u 1001 -S ach -G ach

ENV NODE_ENV=production
ENV PORT=3100
ENV DB_PATH=/app/comm_hub.db

# Copy built artifacts from builder
COPY --from=builder --chown=ach:ach /app/dist              ./dist
COPY --from=builder --chown=ach:ach /app/node_modules      ./node_modules
COPY --from=builder --chown=ach:ach /app/package.json      ./package.json
COPY --from=builder --chown=ach:ach /app/package-lock.json ./package-lock.json

# Copy SDK, docs, deploy and scripts (useful inside container)
COPY --chown=ach:ach client-sdk  ./client-sdk
COPY --chown=ach:ach docs        ./docs
COPY --chown=ach:ach deploy      ./deploy
COPY --chown=ach:ach scripts     ./scripts

# Create data directory with correct permissions
RUN mkdir -p /app/data && chown ach:ach /app/data

# Switch to non-root user
USER ach

EXPOSE 3100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3100/health || exit 1

# Default command
CMD ["node", "dist/src/server.js"]
