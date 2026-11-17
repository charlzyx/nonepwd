interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function renderInstallScript(origin: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

if command -v npm >/dev/null 2>&1; then
  echo "Installing nonepwd CLI (@nonepwd/cli) via npm..."
  npm install -g @nonepwd/cli
  echo "Installed! Run: np --help"
  np --help | head -n 5 || true
  exit 0
fi

echo "Node.js/npm not detected. Install Node.js >= 22 and run: npm install -g @nonepwd/cli" >&2
echo "Or self-host nonepwd server and download native binaries from ${origin}" >&2
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
