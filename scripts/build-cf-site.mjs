import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistDir = path.join(rootDir, 'packages', 'web', 'dist');
const binDistDir = path.join(rootDir, 'dist', 'bin');
const sitePublicDir = path.join(rootDir, 'site', 'public');
const siteOrigin = (
  process.env.NONEPWD_SITE_ORIGIN || 'https://nonepwd.charlzyx.workers.dev'
).replace(/\/+$/, '');

if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
  throw new Error('packages/web/dist not found. Run `pnpm --filter @nonepwd/web build` first.');
}

fs.rmSync(sitePublicDir, { recursive: true, force: true });
fs.mkdirSync(sitePublicDir, { recursive: true });
fs.cpSync(webDistDir, sitePublicDir, { recursive: true });

// Inject public official-site canonical, hreflang, and og:url tags (kept out of self-hosted web bundle)
const siteIndexHtmlPath = path.join(sitePublicDir, 'index.html');
const rawHtml = fs.readFileSync(siteIndexHtmlPath, 'utf8');
const seoLinks = [
  `    <link rel="canonical" href="${siteOrigin}/" />`,
  `    <link rel="alternate" hreflang="en" href="${siteOrigin}/?lang=en" />`,
  `    <link rel="alternate" hreflang="zh-CN" href="${siteOrigin}/?lang=zh" />`,
  `    <link rel="alternate" hreflang="x-default" href="${siteOrigin}/" />`,
  `    <meta property="og:url" content="${siteOrigin}/" />`,
].join('\n');
fs.writeFileSync(
  siteIndexHtmlPath,
  rawHtml.replace('</head>', `${seoLinks}\n  </head>`),
  'utf8'
);

// Generate robots.txt and sitemap.xml for search engine indexing
const robotsTxt = `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`;
fs.writeFileSync(path.join(sitePublicDir, 'robots.txt'), robotsTxt, 'utf8');

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
fs.writeFileSync(path.join(sitePublicDir, 'sitemap.xml'), sitemapXml, 'utf8');

// Copy browser extension bundle (and native CLI binaries if built in dist/bin)
const downloadsDir = path.join(sitePublicDir, 'downloads');
fs.mkdirSync(downloadsDir, { recursive: true });
for (const filename of ['nonepwd-extension.zip', 'np-darwin-arm64', 'np-linux-x86_64']) {
  const src = path.join(binDistDir, filename);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(downloadsDir, filename));
  }
}

// Publish canonical single-source Agent docs at both /SKILL.md and /llms.txt
const skillSrc = path.join(rootDir, 'SKILL.md');
if (fs.existsSync(skillSrc)) {
  fs.copyFileSync(skillSrc, path.join(sitePublicDir, 'SKILL.md'));
  fs.copyFileSync(skillSrc, path.join(sitePublicDir, 'llms.txt'));
}

console.log(`Built Cloudflare site static assets in ${sitePublicDir}`);
