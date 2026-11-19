import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');
const envLocalPath = path.join(pkgDir, '.env.local');
const baseWranglerPath = path.join(pkgDir, 'wrangler.jsonc');
const publicDir = path.join(pkgDir, 'public');

function loadDotEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    out[key] = val;
  }
  return out;
}

function parseJsonc(text) {
  const stripped = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped);
}

function injectPublicSeoAssets(siteOrigin) {
  const indexHtmlPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    const rawHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    if (!rawHtml.includes('rel="canonical"')) {
      const seoLinks = [
        `    <link rel="canonical" href="${siteOrigin}/" />`,
        `    <link rel="alternate" hreflang="en" href="${siteOrigin}/?lang=en" />`,
        `    <link rel="alternate" hreflang="zh-CN" href="${siteOrigin}/?lang=zh" />`,
        `    <link rel="alternate" hreflang="x-default" href="${siteOrigin}/" />`,
        `    <meta property="og:url" content="${siteOrigin}/" />`,
        `    <meta property="og:image" content="${siteOrigin}/screenshots/macos-vault-light.webp" />`,
        `    <meta name="twitter:image" content="${siteOrigin}/screenshots/macos-vault-light.webp" />`,
      ].join('\n');
      fs.writeFileSync(
        indexHtmlPath,
        rawHtml.replace('</head>', `${seoLinks}\n  </head>`),
        'utf8'
      );
    }
  }

  const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`;
  fs.writeFileSync(path.join(publicDir, 'robots.txt'), robotsTxt, 'utf8');

  const today = new Date().toISOString().slice(0, 10);
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${siteOrigin}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="en" href="${siteOrigin}/?lang=en" />
    <xhtml:link rel="alternate" hreflang="zh-CN" href="${siteOrigin}/?lang=zh" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${siteOrigin}/" />
  </url>
  <url>
    <loc>${siteOrigin}/?lang=en</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${siteOrigin}/?lang=zh</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${siteOrigin}/SKILL.md</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${siteOrigin}/llms.txt</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
</urlset>
`;
  fs.writeFileSync(path.join(publicDir, 'sitemap.xml'), sitemapXml, 'utf8');
}

const localEnv = loadDotEnv(envLocalPath);
const domain = (process.env.NONEPWD_CF_DOMAIN || localEnv.NONEPWD_CF_DOMAIN || '')
  .trim()
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');
const d1Id = (process.env.NONEPWD_CF_D1_ID || localEnv.NONEPWD_CF_D1_ID || '').trim();
const skipRoutes =
  (process.env.NONEPWD_CF_SKIP_ROUTES || localEnv.NONEPWD_CF_SKIP_ROUTES || '') === '1';

if (domain) {
  injectPublicSeoAssets(`https://${domain}`);
}

const originalWranglerContent = fs.readFileSync(baseWranglerPath, 'utf8');
let patchedWrangler = false;

function restoreWrangler() {
  if (patchedWrangler) {
    fs.writeFileSync(baseWranglerPath, originalWranglerContent, 'utf8');
    patchedWrangler = false;
  }
}

process.on('SIGINT', () => {
  restoreWrangler();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restoreWrangler();
  process.exit(143);
});

if (domain || d1Id) {
  const config = parseJsonc(originalWranglerContent);
  delete config.build;
  if (d1Id && Array.isArray(config.d1_databases) && config.d1_databases[0]) {
    config.d1_databases[0].database_id = d1Id;
  }
  if (domain && !skipRoutes) {
    config.routes = [{ pattern: domain, custom_domain: true }];
  }
  fs.writeFileSync(baseWranglerPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  patchedWrangler = true;
}

const useWranglerCli = process.argv.includes('--wrangler');
const forwardArgs = process.argv.slice(2).filter((a) => a !== '--wrangler');

try {
  const cmd = useWranglerCli ? 'npx' : 'pnpm';
  const cmdArgs = useWranglerCli
    ? ['wrangler', 'deploy', ...forwardArgs]
    : ['exec', 'cf', 'deploy', ...forwardArgs];
  const res = spawnSync(cmd, cmdArgs, {
    cwd: pkgDir,
    stdio: 'inherit',
    env: { ...process.env, CI: process.env.CI || '1' },
  });
  process.exitCode = res.status ?? 1;
} finally {
  restoreWrangler();
}
