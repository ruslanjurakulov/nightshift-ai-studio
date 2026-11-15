#!/usr/bin/env node
/** Build a private side-by-side review artifact from unchanged browser captures. */
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const out=path.resolve(process.argv[2]||'/tmp/nightshift-premium-d1');
const report=phase=>{const file=path.join(out,phase,'report-capture.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;};
const before=report('before'),after=report('after');
if(!before||!after)throw new Error('Both completed capture reports are required');
const rows=after.results.map(a=>({...a,before:before.results.find(b=>b.id===a.id&&b.width===a.width&&b.theme===a.theme)?.file||null}));
if(rows.some(r=>!r.before))throw new Error('Missing matching baseline image');
const data=JSON.stringify(rows).replace(/</g,'\\u003c');
const html=`<!doctype html><html lang="uz"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nightshift D1 — ekranlar taqqoslashi</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0c1020;color:#f3f4ff;font:16px/1.55 system-ui,sans-serif}header,main{max-width:1600px;margin:auto;padding:24px}header{border-bottom:1px solid #384567}h1{margin:0 0 8px;font-size:28px}p{color:#b9c2dc}label{display:inline-flex;flex-direction:column;gap:4px;margin:8px 16px 8px 0}select,button,a{font:inherit}select,button{background:#1e2741;color:#f3f4ff;border:1px solid #7484a8;border-radius:10px;padding:10px;min-height:44px}a{color:#b9aaff}button{cursor:pointer}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #b9aaff;outline-offset:3px}.panes{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pane{min-width:0;background:#141a2e;border:1px solid #384567;border-radius:16px;overflow:hidden}.pane h2{margin:0;padding:14px;font-size:18px}.frame{max-height:78vh;overflow:auto;background:#fff}.frame img{display:block;width:100%;height:auto}.meta{padding:14px;border-top:1px solid #384567}.note{border-left:3px solid #9b8afb;padding:10px 16px;background:#141a2e}.badge{display:inline-block;padding:3px 10px;border:1px solid #7484a8;border-radius:20px;font-size:13px}#ref img{max-width:100%;height:auto;margin-top:12px}details{margin-top:24px}summary{cursor:pointer;min-height:44px}@media(max-width:800px){.panes{grid-template-columns:1fr}header,main{padding:16px}.frame{max-height:65vh}}</style>
<header><span class="badge">D1 · Lokal browser QA · Sintetik ma’lumotlar</span><h1>Nightshift Premium Visual Foundation</h1><p>Oldingi va yangi ekranlarni bir xil o‘lcham va mavzuda ko‘ring. Bu haqiqiy Next.js komponentlarining Chromium suratlari; production ma’lumotlari emas.</p>
<label>Ekran<select id="screen"></select></label><label>O‘lcham<select id="width"></select></label><label>Mavzu<select id="theme"><option value="dark">Dark</option><option value="light">Light</option></select></label><button id="prev">← Oldingi ekran</button> <button id="next">Keyingi ekran →</button>
<p class="note">Faqat D1: ranglar, umumiy komponentlar va N hisob menyusi. D2–D6, yangi owner moliyasi, Canvas–Timeline sinxronizatsiyasi yoki MCP imkoniyatlari joriy qilinmagan. Bu sahifada hech qanday to‘lov, generatsiya, merge yoki deploy amali yo‘q.</p></header>
<main><h2 id="name"></h2><p id="note"></p><div class="panes"><section class="pane"><h2>Oldingi · PR #799 asosidagi o‘zgarmagan kod</h2><div class="frame"><img id="old" alt="Oldingi ekran"></div><div class="meta"><a id="oldlink" target="_blank" rel="noopener">Suratni to‘liq ochish</a></div></section><section class="pane"><h2>Yangi · D1 feature branch</h2><div class="frame"><img id="new" alt="D1 yangi ekran"></div><div class="meta"><a id="newlink" target="_blank" rel="noopener">Suratni to‘liq ochish</a></div></section></div>
<details id="ref"><summary>Asl vizual yo‘nalish — foydalanuvchi bergan mockup</summary><p>Maketi dizayn yo‘nalishi sifatida ko‘rsatilgan. Undagi raqamlar va yangi modullar D1’da jonli imkoniyat deb olinmaydi.</p><img id="reference" alt="Foydalanuvchi taqdim etgan vizual reference"></details>
<details><summary>N-avatar menyusi — til va mobil holatlar</summary><div id="menus"></div></details>
<p>Klaviatura: Tab bilan boshqarish, select’larda o‘q tugmalari. Tasdiq va fikrlaringizni suhbatda yozing; bu galereya backend vakolatini o‘zgartirmaydi.</p></main>
<script>const rows=${data};const $=id=>document.getElementById(id);const ids=[...new Set(rows.map(r=>r.id))];const widths=[...new Set(rows.map(r=>r.width))].sort((a,b)=>a-b);for(const id of ids)$('screen').add(new Option(id,id));for(const w of widths)$('width').add(new Option(w+' px',w));$('width').value='1440';
const refs=${JSON.stringify({
 '01-executive':'01_owner_executive_overview.png','02-api-models':'02_owner_api_model_intelligence.png','03-customers':'03_owner_customers.png','04-plans-credits':'04_owner_subscriptions_payments.png','05-cost-finance':'05_owner_finance_profit.png','06-infrastructure':'06_owner_infrastructure.png','07-security':'07_owner_security_audit.png','08-canvas':'08_personal_studio_canvas_timeline.png','09-customer-home':'09_customer_dashboard.png','10-composer':'10_customer_studio_composer.png'
})};
function draw(){const r=rows.find(r=>r.id===$('screen').value&&r.width===Number($('width').value)&&r.theme===$('theme').value);if(!r)return;$('name').textContent=r.id;$('note').textContent=r.note;$('old').src=$('oldlink').href='before/'+r.before;$('new').src=$('newlink').href='after/'+r.file;const ref=refs[r.id];$('ref').hidden=!ref;if(ref)$('reference').src='references/'+ref;document.querySelectorAll('.frame').forEach(el=>el.scrollTop=0);}
for(const id of ['screen','width','theme'])$(id).addEventListener('change',draw);$('prev').onclick=()=>{$('screen').selectedIndex=($('screen').selectedIndex+ids.length-1)%ids.length;draw()};$('next').onclick=()=>{$('screen').selectedIndex=($('screen').selectedIndex+1)%ids.length;draw()};
function menus(){ $('menus').replaceChildren();for(const loc of ['en','ru','uz'])for(const view of ['menu','menu-actions']){const a=document.createElement('a');a.href='checks/'+view+'-'+$('width').value+'-'+loc+'-'+$('theme').value+'.jpg';a.textContent=loc.toUpperCase()+(view==='menu'?' menyu':' amallar');a.style.marginRight='20px';a.target='_blank';a.rel='noopener';$('menus').append(a);}}for(const id of ['width','theme'])$(id).addEventListener('change',menus);menus();draw();</script></html>`;
writeFileSync(path.join(out,'index.html'),html);
const references=process.argv[3];
if(references){mkdirSync(path.join(out,'references'),{recursive:true});for(const f of readdirSync(references))if(f.endsWith('.png'))copyFileSync(path.join(references,f),path.join(out,'references',f));}
writeFileSync(path.join(out,'comparison-index.json'),JSON.stringify({note:'Synthetic loopback-only browser fixtures; not production metrics',beforeBase:before.base,afterBase:after.base,rows},null,2));
const findingKey=f=>JSON.stringify([f.id,f.width,f.theme,f.kind,f.pixels,f.actual,f.expected,f.errors]);
const baselineFindings=new Set(before.failures.map(findingKey));
const publicPaletteChanges=rows.filter(r=>!r.app).filter(r=>{
 const old=before.results.find(b=>b.id===r.id&&b.width===r.width&&b.theme===r.theme);
 return ['ground','console','fg','bodyPremium'].some(k=>old[k]!==r[k]);
}).map(r=>({id:r.id,width:r.width,theme:r.theme}));
writeFileSync(path.join(out,'comparison-summary.json'),JSON.stringify({
 beforeScreens:before.results.length,afterScreens:after.results.length,matched:rows.length,
 baselineFindings:before.failures,remainingBaselineFindings:after.failures.filter(f=>baselineFindings.has(findingKey(f))),
 newFindings:after.failures.filter(f=>!baselineFindings.has(findingKey(f))),publicPaletteChanges,
 note:'An unchanged finding is still a limitation, not a passing result. Image review is separate from these measured checks.'
},null,2));
console.log('Review gallery:',path.join(out,'index.html'),rows.length,'matched comparisons');
