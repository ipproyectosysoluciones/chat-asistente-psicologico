# syntax=docker/dockerfile:1
# Multi-stage production image for @chatcap/notifications (alert routing service).
# Builds the app and its workspace dependencies, then ships only production
# dependencies plus the compiled dist/.

# ---- Stage 1: builder ----
FROM node:20-slim AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH" \
    NODE_ENV=production

WORKDIR /app

# Enable the pnpm version pinned in package.json (packageManager field).
RUN corepack enable

# Copy the full source tree (minus node_modules/dist, see .dockerignore).
# The whole tree must be present BEFORE install: pnpm needs every workspace
# member's package.json to resolve the monorepo graph.
COPY . .

# Frozen lockfile enforces reproducibility; fails if pnpm-lock.yaml is out of sync.
RUN pnpm install --frozen-lockfile

# Build the app and all of its workspace dependencies (the "..." selector
# includes dependencies).
RUN pnpm --filter @chatcap/notifications... build

# Produce a standalone, production-only node_modules with workspace packages
# inlined. Output lands in /out (app files + node_modules).
RUN pnpm --filter @chatcap/notifications deploy --prod /out

# ---- Stage 2: runtime ----
FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    PORT=4002

WORKDIR /app

# Run as a non-root user.
RUN useradd -m appuser

# Copy production deps (workspace deps inlined by pnpm deploy) + app files.
COPY --from=builder /out/ ./

# Runtime stage has no pnpm/corepack enabled; install tsx globally via npm so
# the CLI is on PATH. The compiled entry imports @chatcap/* packages whose
# "exports" point at raw .ts sources, so node alone crashes with
# "Unknown file extension .ts"; tsx strips types at runtime.
RUN npm install -g tsx

# Explicitly copy the freshly built app output (guarantees dist/ is present).
COPY --from=builder /app/apps/notifications/dist ./dist

# Drop privileges.
USER appuser

EXPOSE 4002

# Entry point: run the compiled ESM app through tsx (handles .ts re-exports).
CMD ["tsx", "dist/index.js"]
