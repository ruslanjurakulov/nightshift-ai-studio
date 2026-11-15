#!/usr/bin/env node
/** Real local Next pages and browser interactions with synthetic, loopback-only data. No paid actions. */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (key, fallback) => { const i = process.argv.indexOf(`--${key}`); return i < 0 ? fallback : process.argv[i + 1]; };
const base = arg("base", "http://127.0.0.1:3492");
const fake = arg("fake", "http://127.0.0.1:54399");
for (const url of [base, fake]) if (!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw new Error("Local fixtures only");
const phase = arg("phase", "after");
const out = path.resolve(arg("out", `/tmp/nightshift-premium-d1-${phase}`));
const widths = arg("widths", "375,390,430,768,1440,1920").split(',').map(Number);
const themes = arg("themes", "light,dark").split(',');
const mode = arg("mode", "capture");
const checkRole = arg("role", "customer");
mkdirSync(out,{recursive:true});
const film = '0f000000-0000-4000-8000-00000000000f';
const screens = [
 {id:'01-executive',route:'/chronos/command-center',state:'owner',note:'Existing command center, not a new finance dashboard'},
 {id:'02-api-models',route:'/chronos/billing',state:'owner',note:'Existing provider billing components; incomplete reads remain honest'},
 {id:'03-customers',route:'/chronos/customers',state:'owner',note:'Existing read report; fixture does not claim real customers'},
 {id:'04-plans-credits',route:'/night-owl/credits',state:'videos',note:'Existing customer credits/plans; owner merchant dashboard is outside D1'},
 {id:'05-cost-finance',route:'/chronos/billing#ue-title',state:'owner',note:'Existing unit economics; no new net-profit claims'},
 {id:'06-infrastructure',route:'/chronos/jobs',state:'owner',note:'Existing jobs/worker evidence, not synthetic GPU telemetry'},
 {id:'07-security',route:'/chronos/security',state:'owner',note:'Existing security settings; no new SOC2/owner authority'},
 {id:'08-canvas',route:'/night-owl/studio',state:'canvas',note:'Existing typed local sketch; no new synchronization'},
 {id:'09-customer-home',route:'/night-owl/home',state:'videos',note:'Same customer components for all Personal Studio users'},
 {id:'10-composer',route:'/night-owl/create',state:'videos',note:'Existing composer, no generation started'},
 {id:'11-timeline',route:`/night-owl/studio?view=timeline&film=${film}`,state:'timeline',note:'Existing Film timeline; pending PR793 fixes are not part of D1'},
 {id:'12-account',route:'/night-owl/organization',state:'acct_handle',note:'Profile/photo/email/security preserved'},
 {id:'13-public-pricing',route:'/pricing',state:null,note:'Public visual regression control: should retain original theme'},
];
const picked = arg('screens','').split(',').filter(Boolean);
const selected = picked.length ? screens.filter(s=>picked.includes(s.id)) : screens;
const results=[], failures=[];
const fixtureGraph = {
 v:1,
 nodes:[
  {id:'words',kind:'prompt',x:-336,y:0,draft:'QA fixture: cinematic landscape at dawn'},
  {id:'image',kind:'image',x:0,y:0,jobId:'0c000000-0000-4000-8000-0000000000c1'},
  {id:'animate',kind:'animate',x:336,y:0},
  {id:'library',kind:'asset',x:0,y:356,assetId:'0c000000-0000-4000-8000-0000000000a1',assetKind:'image'},
  {id:'video',kind:'video',x:336,y:356,jobId:'0c000000-0000-4000-8000-0000000000c3'},
  {id:'enhance',kind:'enhance',x:672,y:0},
 ].map(n=>({jobId:null,assetId:null,assetKind:null,draft:'',effectId:null,...n})),
 wires:[{id:'w0',from:'words',to:'image'},{id:'w1',from:'image',to:'animate'},{id:'w2',from:'video',to:'enhance'}],
 view:{x:0,y:0,k:1},
};
const browser=await chromium.launch({executablePath:process.env.VISUAL_QA_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
async function open(s,width,theme,locale='en') {
 const context=await browser.newContext({viewport:{width,height:width<600?844:1000},colorScheme:theme,reducedMotion:'reduce',hasTouch:width<1024,isMobile:width<600});
 const blocked=new Set();
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname)){blocked.add(u.hostname);return route.abort();}return route.continue();});
 const cookies=[{name:'chronos_locale',value:locale,url:base}];
 if(s.state)cookies.push({...sessionCookie(fake,s.state),url:base});
 await context.addCookies(cookies);
 // The app's existing prepaint script applies this preference after <html> exists.
 await context.addInitScript(t=>localStorage.setItem('chronos_theme',t),theme);
 if(s.id==='08-canvas')await context.addInitScript(g=>localStorage.setItem('ns.studio.canvas.v1:00000000-0000-4000-8000-0000000000b1:night-owl:00000000-0000-4000-8000-0000000000aa',JSON.stringify(g)),fixtureGraph);
 const page=await context.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+s.route,{waitUntil:'load',timeout:120000});
 await page.locator('body').waitFor();
 await page.addStyleTag({content:'nextjs-portal { display:none !important; }'});
 await page.waitForTimeout(900);
 return {context,page,errors,blocked};
}
async function measure(page){return page.evaluate(()=>{
 const shell=document.querySelector('.app-shell');const target=shell||document.body;const st=getComputedStyle(target);
 const visible=e=>!!(e.getBoundingClientRect().width&&e.getBoundingClientRect().height);
 const canvas=document.querySelector('.cv-root');const cv=canvas?getComputedStyle(canvas):null;
 return {url:location.pathname,app:!!shell,overflow:document.documentElement.scrollWidth-innerWidth,
 ground:st.getPropertyValue('--ns-ground').trim(),console:st.getPropertyValue('--ns-console').trim(),fg:st.color,
 bodyPremium:getComputedStyle(document.body).getPropertyValue('--premium-ground').trim(),
 canvasGround:cv?.getPropertyValue('--ground').trim()||null,canvasConsole:cv?.getPropertyValue('--console').trim()||null,
 avatar: [...document.querySelectorAll('header .ns-account-trigger')].filter(visible).length,
 heading:document.querySelector('h1')?.textContent?.trim()||null,
 runningAnimations:document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.target instanceof Element&&a.effect.target.closest('.app-shell')).map(a=>a.animationName||'motion')};
 });}
try {
 if(mode==='capture') {
  for(const s of selected)for(const width of widths)for(const theme of themes){
   const {context,page,errors,blocked}=await open(s,width,theme);
   const file=`${s.id}-${width}-${theme}.jpg`;
   await page.screenshot({path:path.join(out,file),type:'jpeg',quality:82,fullPage:true});
   const r={id:s.id,width,theme,file,note:s.note,...await measure(page),errors,blocked:[...blocked]};results.push(r);
   if(errors.length)failures.push({id:s.id,width,theme,kind:'pageerror',errors});
   if(r.overflow>1)failures.push({id:s.id,width,theme,kind:'overflow',pixels:r.overflow});
   if(r.app&&r.runningAnimations.length)failures.push({id:s.id,width,theme,kind:'reduced-motion',animations:r.runningAnimations});
   if(phase==='after'&&r.app){
    const expected=theme==='light'?'#f4f5fb':'#0c1020';
    if(r.ground!==expected)failures.push({id:s.id,width,theme,kind:'app-palette',actual:r.ground,expected});
    if(r.avatar!==1)failures.push({id:s.id,width,theme,kind:'account-trigger',count:r.avatar});
    if(r.canvasGround&&r.canvasGround!==expected)failures.push({id:s.id,width,theme,kind:'canvas-palette',actual:r.canvasGround,expected});
   }
   if(!r.app&&r.bodyPremium)failures.push({id:s.id,width,theme,kind:'public-palette-leak',actual:r.bodyPremium});
   process.stdout.write(`${phase} ${s.id} ${width} ${theme} ${r.app?'app':'public'} overflow=${r.overflow}\n`);
   await context.close();
  }
 } else {
  const axe=readFileSync(path.join(root,'command-center/node_modules/axe-core/axe.min.js'),'utf8');
  for(const width of widths)for(const locale of ['en','ru','uz'])for(const theme of themes){
   const s=screens.find(s=>s.id===(checkRole==='owner'?'01-executive':'09-customer-home'));const {context,page,errors}=await open(s,width,theme,locale);
   const r={role:checkRole,width,locale,theme,...await measure(page)};
   const trigger=page.locator('header .ns-account-trigger');
   if(await trigger.count()!==1)throw new Error(`Expected one account trigger: ${width}/${locale}/${theme}`);
   const box=await trigger.boundingBox();if(!box||box.width<43.5||box.height<43.5)throw new Error('Account target <44px');
   if(await trigger.evaluate(el=>getComputedStyle(el).borderRadius)!=='50%')throw new Error('N account target is not circular');
   if(width<600){await trigger.tap();await page.locator('[data-premium-account]').waitFor({state:'visible'});await page.keyboard.press('Escape');r.touchOpen=true;}
   await trigger.focus();await page.keyboard.press('Enter');
   const dialog=page.locator('[data-premium-account]');await dialog.waitFor({state:'visible'});
   const links=await dialog.locator('a').evaluateAll(xs=>xs.map(x=>({label:x.textContent.trim(),href:x.getAttribute('href')})));
   if(links.some(x=>/command-center|\/billing|\/customers|\/model-keys/.test(x.href||'')))throw new Error('Unexpected owner link in customer menu');
   if(!await dialog.locator('a[href$="/studio"]').count())throw new Error('Personal Studio missing');
   if(!await dialog.locator('a[href$="/organization"]').count())throw new Error('Settings missing');
   if(await dialog.locator('.ns-theme-choice').count()!==2)throw new Error('Both theme choices required');
   for(const choice of await dialog.locator('.ns-theme-choice').all()){
    const target=await choice.boundingBox();if(!target||target.width<43.5||target.height<43.5)throw new Error('Theme target <44px');
   }
   await dialog.locator('.ns-theme-choice').first().click();
   if(await page.locator('html').getAttribute('data-theme')!=='light')throw new Error('Light not applied');
   await dialog.locator('.ns-theme-choice').last().click();
   if(await page.locator('html').getAttribute('data-theme')!=='dark')throw new Error('Dark not applied');
   if(theme==='light')await dialog.locator('.ns-theme-choice').first().click();
   await dialog.focus();
   await page.keyboard.press('Shift+Tab');
   if(!await dialog.evaluate(el=>document.activeElement===el.querySelector('button:last-child')||el.contains(document.activeElement)))throw new Error('Reverse Tab escaped account dialog');
   await page.keyboard.press('Tab');
   if(!await dialog.evaluate(el=>el.contains(document.activeElement)))throw new Error('Tab escaped account dialog');
   await page.evaluate(axe);
   r.menuAxe=await page.evaluate(async()=>{const r=await window.axe.run(document.querySelector('[data-premium-account]'));return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}));});
   if(r.menuAxe.length)failures.push({width,locale,theme,kind:'menu-axe',violations:r.menuAxe});
   const nav=page.locator('.ns-tabbar');
   if(await nav.isVisible()){
    const menuBox=await dialog.boundingBox(),navBox=await nav.boundingBox();
    if(menuBox&&navBox&&menuBox.y+menuBox.height>navBox.y+1)throw new Error('Account menu overlaps bottom navigation');
   }
   await dialog.evaluate(el=>el.scrollTop=0);await page.evaluate(()=>scrollTo(0,0));
   await page.screenshot({path:path.join(out,`menu-${width}-${locale}-${theme}.jpg`),type:'jpeg',quality:82});
   const lastAction=dialog.locator('button').last();await lastAction.scrollIntoViewIfNeeded();
   if(!await lastAction.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}))throw new Error('Last account action is covered');
   await page.evaluate(()=>scrollTo(0,0));
   await page.screenshot({path:path.join(out,`menu-actions-${width}-${locale}-${theme}.jpg`),type:'jpeg',quality:82});
   await page.keyboard.press('Escape');
   if(!await trigger.evaluate(el=>el===document.activeElement))throw new Error('Escape did not restore focus');
   if(r.overflow>1)failures.push({width,locale,theme,kind:'overflow',pixels:r.overflow});
   if(r.runningAnimations.length)failures.push({width,locale,theme,kind:'reduced-motion',animations:r.runningAnimations});
   await page.evaluate(axe);
   r.axe=await page.evaluate(async()=>{const r=await window.axe.run(document.querySelector('.app-shell'));return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}));});
   if(r.axe.some(v=>v.impact==='critical'||v.impact==='serious'))failures.push({width,locale,theme,kind:'axe',violations:r.axe});
   if(width===390&&theme==='dark'){
    const nextLocale={en:'ru',ru:'uz',uz:'en'}[locale];
    await trigger.click();await dialog.locator(`button[lang="${nextLocale}"]`).click();
    await page.waitForFunction(l=>document.querySelector(`button[lang="${l}"]`)?.getAttribute('aria-pressed')==='true',nextLocale);
    if(!await page.evaluate(l=>document.cookie.split('; ').includes(`chronos_locale=${l}`),nextLocale))throw new Error('Locale preference was not saved');
    r.languageTransition=`${locale}->${nextLocale}`;await page.keyboard.press('Escape');
   }
   r.errors=errors;results.push(r);if(errors.length)failures.push({width,locale,theme,kind:'pageerror',errors});
   console.log(`checks ${width} ${locale} ${theme} menu/focus/theme done`);await context.close();
  }
 }
}catch(error){
 failures.push({kind:'execution',message:error instanceof Error?error.message:String(error)});
 throw error;
}finally{
 await browser.close();
 writeFileSync(path.join(out,`report-${mode}.json`),JSON.stringify({phase,base,fixture:fake,note:'Local synthetic fixture render; not production data/security proof',results,failures},null,2));
}
if(failures.length){console.error(JSON.stringify({failures},null,2));process.exitCode=1;}
