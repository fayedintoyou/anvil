// Renders public/icon.svg to the 1024px public/icon.png used as the Discord app icon:
//   node scripts/render-icon.mjs public/icon.svg public/icon.png     (CHROME=/path/to/chrome if not on a Mac)
import { chromium } from 'playwright-core';
const [svg, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
await p.setContent(`<body style="margin:0"><img src="data:image/svg+xml;base64,${Buffer.from(await (await import('node:fs/promises')).readFile(svg)).toString('base64')}" width=1024 height=1024>`);
await p.screenshot({ path: out });
await b.close();
