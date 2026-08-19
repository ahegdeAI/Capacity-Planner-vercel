# `pg` (node-postgres) is a pure-JS driver — no native build toolchain
# needed (unlike the old better-sqlite3 dependency), so the slim image is
# fine here.
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Only the dev-mode mail outbox log is written to disk locally (best-effort,
# never load-bearing — see server/mailer.js); all real persistence
# (resources/projects/allocations/audit/versions/sessions) lives in Postgres
# via DATABASE_URL, not on this container's filesystem. This directory is
# optional — mail-outbox.log is skipped silently if it's not writable.
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
