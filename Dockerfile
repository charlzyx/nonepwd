FROM rust:1-bookworm AS rust-builder

WORKDIR /app
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
RUN cargo build -p nonepwd-core --target wasm32-unknown-unknown --release && \
    cargo build -p nonepwd-cli --release

FROM node:26-slim AS builder

WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/cf-email-worker/package.json packages/cf-email-worker/
COPY packages/web/package.json packages/web/
COPY packages/extension/package.json packages/extension/

RUN pnpm install --frozen-lockfile

COPY packages packages
COPY --from=rust-builder /app/target/wasm32-unknown-unknown/release/nonepwd_core.wasm /tmp/nonepwd_core.wasm
RUN node -e "const fs=require('fs'); const b64=fs.readFileSync('/tmp/nonepwd_core.wasm').toString('base64'); fs.writeFileSync('packages/core/src/wasm-embedded.ts', 'export const NONEPWD_CORE_WASM_B64 = \"' + b64 + '\";\n');" && \
    pnpm --filter @nonepwd/core build && \
    pnpm --filter @nonepwd/web build && \
    pnpm --filter @nonepwd/extension build && \
    pnpm --filter @nonepwd/server build && \
    pnpm --filter @nonepwd/cli build

FROM node:26-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NONEPWD_HOST=0.0.0.0 \
    NONEPWD_PORT=8787 \
    NONEPWD_DATA_DIR=/data

COPY --from=rust-builder /app/target/release/np /usr/local/bin/np
COPY --from=builder /app/dist/bin/nonepwd-extension.zip ./dist/bin/nonepwd-extension.zip
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/web/dist ./packages/web/dist

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "packages/server/dist/index.js"]
