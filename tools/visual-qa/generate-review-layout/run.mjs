#!/usr/bin/env node
// Synthetic component mount in installed Chromium, via its private debugging
// pipes. No HTTP server, real account, provider, or browser package is needed.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const cc = path.join(repo, "command-center");
const require = createRequire(path.join(cc, "package.json"));
const { build } = require("esbuild");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const out = path.resolve(process.argv[2] ?? path.join(repo, "../NS-BATCH-172-layout-evidence"));
await mkdir(out, { recursive: true });

const stubs = {
  "next/link": 'import React from "react"; export default function Link({children,href,...props}) { return React.createElement("a",{...props,href},children); }',
  "next/navigation": 'export const usePathname=()=>"/synthetic/create"; export const useRouter=()=>({refresh(){},push(){}});',
  "@/lib/channels-client": 'export const useChannelPath=()=>p=>"/synthetic"+p;',
  "@/lib/credits-live": 'export const useLiveCredits=()=>null; export const refreshCredits=async()=>{};',
  "@/components/studio/useStyleKits": 'export const useStyleKits=()=>({state:"ready",kits:[{id:"22222222-2222-4222-8222-222222222222",name:"SyntheticLookWithAnIntentionallyLongUnbrokenNameThatMustWrapInsideTheReview"}],reload(){}});',
};
await build({
  entryPoints: [path.join(here, "mount.tsx")], outfile: path.join(out, "mount.js"), bundle: true,
  platform: "browser", format: "iife", jsx: "automatic", alias: { "@": cc },
  nodePaths: [path.join(cc, "node_modules")], conditions: ["browser", "style", "import"],
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [{ name: "synthetic-only-boundaries", setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "synthetic" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "synthetic" }, args => ({ contents: stubs[args.path], loader: "js", resolveDir: cc }));
  } }],
});
const rawCss = await readFile(path.join(out, "mount.css"), "utf8");
const css = (await postcss([tailwind({ base: cc, optimize: false })]).process(rawCss, { from: path.join(cc, "layout-qa.css") })).css;
await writeFile(path.join(out, "compiled.css"), css);
const js = await readFile(path.join(out, "mount.js"), "utf8");

const browser = spawn(process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", [
  "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-pipe",
  "--disable-background-networking", "--disable-component-update", "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=http://127.0.0.1:9",
  `--user-data-dir=${path.join(out, "synthetic-profile")}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let id = 0, buffer = "", stderr = "";
const waiting = new Map();
const exceptions = [];
browser.stderr.on("data", b => { stderr = (stderr + b).slice(-8000); });
browser.stdio[4].on("data", data => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (m.id) { const p = waiting.get(m.id); if (p) { waiting.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }
    if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails);
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`CDP timeout: ${method}; ${stderr}`)); }, 30000);
    waiting.set(n, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}
let results = [];
try {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp(method, params, sessionId);
  await send("Page.enable"); await send("Runtime.enable");
  await send("Network.enable"); await send("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
  const evaluate = async expression => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (const width of [360, 390, 1440]) for (const locale of ["en", "ru", "uz"]) for (const theme of ["light", "dark"]) for (const layout of ["panel", "composer"]) {
    await evaluate("window.unmountReview?.()");
    const height = width < 600 ? 800 : 1000;
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    const { frameTree } = await send("Page.getFrameTree");
    const storage = '(()=>{const memory=new Map();Object.defineProperty(window,"localStorage",{configurable:true,value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)}})})();';
    const html = `<!doctype html><html lang="${locale}" data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:16px}#mount{max-width:960px;margin:auto;min-width:0}</style></head><body><div id="mount"></div><script>${storage}${js.replaceAll("</script", "<\\/script")}\nwindow.mountReview(${JSON.stringify(locale)},${JSON.stringify(layout)});</script></body></html>`;
    await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
    await evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(document.querySelector('[data-testid="gen-review"][data-state="ready"]')){clearInterval(timer);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))}else if(++n>150){clearInterval(timer);reject(new Error("Review not ready"))}},20)})`);
    const measured = await evaluate(`(()=>{
      const review=document.querySelector('[data-testid="gen-review"]');
      const button=document.querySelector('button[aria-describedby="gen-status"]');
      const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const rect=box(review), action=box(button);
      const overflow=[review,...review.querySelectorAll('dt,dd')].filter(e=>{const r=e.getBoundingClientRect();return r.left < -1 || r.right>innerWidth+1 || e.scrollWidth>e.clientWidth+1}).map(e=>({tag:e.tagName,text:e.textContent,client:e.clientWidth,scroll:e.scrollWidth,...box(e)}));
      const overlap=rect.left<action.right&&rect.right>action.left&&rect.top<action.bottom&&rect.bottom>action.top;
      return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,review:rect,action,overflow,overlap,ready:review.dataset.state,rows:review.querySelectorAll('dt').length,summaryActions:review.querySelectorAll('button,a,input').length,calls:window.syntheticCalls};
    })()`);
    const failures = [];
    if (measured.documentWidth > measured.viewport + 1) failures.push("page horizontal overflow");
    if (measured.overflow.length) failures.push("review content overflow");
    if (measured.overlap) failures.push("review overlaps Generate");
    if (measured.summaryActions) failures.push("review unexpectedly interactive");
    if (measured.calls.some(c => c === "POST /api/creative/jobs")) failures.push("generation attempted");
    const row = { width, height, locale, theme, layout, pass: failures.length === 0, failures, ...measured };
    results.push(row);
    if (failures.length || (locale === "ru" && theme === "dark" && (width === 390 || width === 1440))) {
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(path.join(out, `${width}-${locale}-${theme}-${layout}.png`), Buffer.from(screenshot.data, "base64"));
    }
  }
  const report = { cases: results.length, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, exceptions, results,
    limits: "Synthetic component mount, source CSS with system fallback fonts, in installed headless Chromium. Next navigation, style-kit read and credits store are fixtures; API fetch is synthetic and external network blocked. No app-shell/native-device/real-account verification." };
  await writeFile(path.join(out, "layout-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ cases: report.cases, passed: report.passed, failed: report.failed, exceptions: exceptions.length, evidence: path.join(out, "layout-results.json") }));
  if (report.failed || exceptions.length) process.exitCode = 1;
} catch (error) {
  await writeFile(path.join(out, "harness-error.json"), JSON.stringify({message:String(error), exceptions, results, stderr}, null, 2));
  throw error;
} finally {
  browser.kill("SIGTERM");
}
