// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/chronos/editor/synthetic' }));
import { ExportStatusPanel } from '@/components/editor/ExportStatusPanel';
import { I18nProvider } from '@/lib/i18n/context';
import { dictionaries, type Locale } from '@/lib/i18n';
import type { MediaAsset } from '@/lib/media';
import type { EditorExport } from '@/lib/editor';
const ID='22222222-2222-4222-8222-222222222222';
const ORIGINAL=`/api/media/file/${ID}/original?exp=123&sig=PUBLIC_SYNTHETIC`;
const STALE=`/api/media/file/${ID}/proxy?exp=1&sig=STALE_SYNTHETIC`;
const row: EditorExport={id:'synthetic-export',rev:1,status:'done',reason:null,durationS:10,assetId:ID,createdAt:null,finishedAt:null};
const asset:MediaAsset={id:ID,kind:'video',mime:'video/mp4',bytes:2048,width:1920,height:1080,durationS:10,source:'render',name:'synthetic.mp4',variants:['proxy'],version:1,createdAt:null};
let request:ReturnType<typeof vi.fn>;
let clicks:{href:string;name:string}[];
beforeEach(()=>{
 clicks=[];
 request=vi.fn();vi.stubGlobal('fetch',request);
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement){clicks.push({href:this.getAttribute('href')!,name:this.download});});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
function mount(locale:Locale){
 const retry=vi.fn();const check=vi.fn(async()=>null);
 render(<I18nProvider locale={locale}><ExportStatusPanel latest={row} assets={{[ID]:{...asset,kind:'video',viewUrl:STALE,thumbUrl:null}}} currentRev={1} dirty={false} busy={false} failing={false} halt={null} checking={false} onRetry={retry} onCheckNow={check}/></I18nProvider>);
 return {retry,check,box:within(document.querySelector('[data-existing-export-file]') as HTMLElement)};
}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
describe.each(['en','ru','uz'] as const)('existing completed export in %s',(locale)=>{
 const ep=dictionaries[locale].editor.exportPanel;
 it('reports a missing linked item while retaining render-done, with only a metadata read',async()=>{
  request.mockResolvedValue(json({error:'not_found'},404));const {retry,check,box}=mount(locale);
  expect(screen.getByText(ep.doneLine)).toBeTruthy();expect(request).not.toHaveBeenCalled();
  fireEvent.click(box.getByRole('button',{name:ep.fileDownload}));
  await box.findByText(ep.fileMissing);
  expect(document.querySelector('[data-export-state]')?.getAttribute('data-export-state')).toBe('done');
  expect(clicks).toEqual([]);expect(retry).not.toHaveBeenCalled();expect(check).not.toHaveBeenCalled();
  expect(request.mock.calls).toEqual([[`/api/media/${ID}`,{cache:'no-store'}]]);
 });
 it('gets a fresh original once and hands it to the browser without claiming completion',async()=>{
  let release!:(r:Response)=>void;request.mockImplementation(()=>new Promise<Response>(r=>{release=r;}));const {retry,check,box}=mount(locale);
  const key=box.getByRole('button',{name:ep.fileDownload});fireEvent.click(key);fireEvent.click(key);
  expect(request).toHaveBeenCalledTimes(1);expect(key).toHaveProperty('disabled',true);
  await act(async()=>{release(json({asset,urls:{original:ORIGINAL,proxy:STALE},served:true,urls_expire_in:600}));});
  expect(clicks).toEqual([{href:ORIGINAL,name:'synthetic.mp4'}]);
  expect(box.getByText(ep.fileHanded)).toBeTruthy();expect(box.getByRole('status').textContent).toContain('video/mp4');
  expect(document.body.textContent).not.toContain('PUBLIC_SYNTHETIC');expect(document.body.textContent).not.toContain('STALE_SYNTHETIC');
  expect(key).toHaveProperty('disabled',false);expect(retry).not.toHaveBeenCalled();expect(check).not.toHaveBeenCalled();
  expect(request.mock.calls.every(([,init])=>!init.method||init.method==='GET')).toBe(true);
 });
 it('keeps stored-but-unserved metadata distinct from a missing item and does not fall back to the stale preview',async()=>{
  request.mockResolvedValue(json({asset,urls:{},served:false}));const {box,retry}=mount(locale);
  fireEvent.click(box.getByRole('button',{name:ep.fileDownload}));await box.findByText(ep.fileUnavailable);
  expect(box.queryByText(ep.fileMissing)).toBeNull();expect(box.getByRole('status').textContent).toContain('video/mp4');
  expect(clicks).toEqual([]);expect(retry).not.toHaveBeenCalled();
 });
 it('offers a user-driven metadata retry after an ordinary read failure, without export or URL text',async()=>{
  request.mockRejectedValueOnce(new Error('synthetic unavailable')).mockResolvedValueOnce(json({asset,urls:{original:ORIGINAL},served:true}));
  const {box,retry}=mount(locale);fireEvent.click(box.getByRole('button',{name:ep.fileDownload}));await box.findByText(ep.fileReadFailed);
  expect(clicks).toEqual([]);fireEvent.click(box.getByRole('button',{name:ep.fileDownload}));await box.findByText(ep.fileHanded);
  expect(request).toHaveBeenCalledTimes(2);expect(clicks).toHaveLength(1);expect(retry).not.toHaveBeenCalled();
 });
});
