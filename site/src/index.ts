interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function renderInstallScript(origin: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

OS="$(uname -s)"
ARCH="$(uname -m)"
BIN_NAME=""

case "$OS:$ARCH" in
  Darwin:arm64|Darwin:aarch64) BIN_NAME="np-darwin-arm64" ;;
  Linux:x86_64|Linux:amd64) BIN_NAME="np-linux-x86_64" ;;
esac

if [[ -n "$BIN_NAME" ]] && command -v curl >/dev/null 2>&1; then
  PREFIX="\${PREFIX:-$HOME/.local/bin}"
  mkdir -p "$PREFIX"
  TMP_BIN="$(mktemp)"
  if curl -fsSL "${origin}/downloads/\${BIN_NAME}" -o "$TMP_BIN"; then
    mv "$TMP_BIN" "$PREFIX/np"
    chmod 755 "$PREFIX/np"
    echo "Installed native nonepwd CLI -> $PREFIX/np"
    "$PREFIX/np" version || true
    exit 0
  fi
  rm -f "$TMP_BIN"
fi

if command -v npm >/dev/null 2>&1; then
  echo "Installing nonepwd CLI (@nonepwd/cli) via npm..."
  npm install -g @nonepwd/cli
  echo "Installed! Run: np --help"
  np --help | head -n 5 || true
  exit 0
fi

echo "Could not install native binary or detect Node.js/npm." >&2
echo "Download binaries from https://github.com/charlzyx/nonepwd/releases/latest or install Node.js >= 22 and run: npm install -g @nonepwd/cli" >&2
exit 1
`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/install.sh') {
      return new Response(renderInstallScript(url.origin), {
        status: 200,
        headers: {
          'Content-Type': 'text/x-shellscript; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    if (url.pathname === '/llms.txt' || url.pathname === '/SKILL.md' || url.pathname === '/skill.md') {
      const assetUrl = new URL('/SKILL.md', url.origin);
      const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
      const body = await res.arrayBuffer();
      return new Response(body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    if (url.pathname === '/api/auth/params' || url.pathname.startsWith('/api/')) {
      return Response.json(
        {
          staticSite: true,
          initialized: false,
          message: 'Public official website; host your own vault via `npx @nonepwd/server`.',
        },
        { status: 404 }
      );
    }

    return env.ASSETS.fetch(request);
  },
};
