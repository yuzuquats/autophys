import { Code } from './code';
import { CodeMirrorEditor } from '../codemirror';
import { RichTextEditor } from '../rich-text-editor/rich-text-editor';
import { ProseMirrorEditor } from '../prosemirror';
import { HtmlEditor } from '../html-editor';
import { Markdown } from '../markdown/markdown';
import { LonaWebComponent } from '../../component';

const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
export const editorDocument = 'A short editor paragraph with **bold** and `code`.\n\n'.repeat(40);
export type EditorKind = 'code'|'codemirror'|'rich'|'prosemirror'|'html'|'markdown';
export type EditorAdapter = { element:LonaWebComponent; bind:(text:string,onUpdate:(text:string)=>void,editable:boolean)=>Promise<void> };
export function editorAdapter(kind:EditorKind):EditorAdapter {
  switch(kind) {
    case 'code': {const element=Code.make();return {element,bind:async text=>{await element.bind({content:text,language:'plain'});}};}
    case 'codemirror': {const element=CodeMirrorEditor.make();return {element,bind:async (text,onUpdate,editable)=>{await element.bind({content:text,language:'plain',onUpdate,editable});}};}
    case 'rich': {const element=RichTextEditor.make();return {element,bind:async (text,onUpdate,editable)=>{await element.bind({markdown:text,onUpdate,editable});}};}
    case 'prosemirror': {const element=ProseMirrorEditor.make();return {element,bind:async (text,onUpdate,editable)=>{await element.bind({markdown:text,onUpdate,editable});}};}
    case 'html': {const element=HtmlEditor.make();return {element,bind:async (text,onChange,editable)=>{await element.bind({html:'<p>'+text+'</p>',onChange,editable});}};}
    case 'markdown': {const element=Markdown.make();return {element,bind:async text=>{element.bind({text});}};}
  }
}
export function deepElements(root:Element|ShadowRoot):Element[] {
  return [...root.children].flatMap(child=>[child,...deepElements(child)]).concat(
    root instanceof Element && root.shadowRoot != null ? deepElements(root.shadowRoot) : []);

}
export function editorRoots(element:Element):HTMLElement[] {
  return deepElements(element).filter((e):e is HTMLElement=>e instanceof HTMLElement&&(e.classList.contains('ProseMirror')||e.classList.contains('cm-editor')));
}
async function settleEditor(adapter:EditorAdapter,marker:string):Promise<void> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    await frame();
    if(editorRoots(adapter.element).some(e=>e.textContent?.includes(marker)))return;
  }
  throw new Error('Current editor content never mounted: '+marker);
}
export async function verifyEditorColdRetirement(kind:EditorKind,mode:string = "mounted"):Promise<string[]> {
  let oldCalls=0,newCalls=0;const old=editorAdapter(kind);const pending=old.bind('RETIRED_A '+editorDocument,()=>oldCalls++,true);
  if(mode==='mounted')document.body.append(old.element);
  old.element.recycle();await frame();
  const next=editorAdapter(kind);check(next.element===old.element,kind+' actual pool reuse missing');
  const current=next.bind('CURRENT_B '+editorDocument,()=>newCalls++,false);document.body.append(next.element);
  await Promise.all([pending,current]);await settleEditor(next,'CURRENT_B');
  check(editorRoots(next.element).length===1,kind+' has multiple surviving vendor roots');
  check(!editorRoots(next.element).some(e=>e.textContent?.includes('RETIRED_A')),kind+' old loader painted A');
  check(oldCalls===0&&newCalls===0,kind+' load notified stale/current change delegate');
  check(!deepElements(next.element).some(e=>e.getAttribute('contenteditable')==='true'),kind+' read-only adapter editable');
  next.element.remove();await frame();check(editorRoots(next.element).length===0,kind+' detach retained view DOM');document.body.append(next.element);await settleEditor(next,'CURRENT_B');
  next.element.recycle();await frame();await frame();check(editorRoots(next.element).length===0,kind+' recycle retained vendor DOM');
  const detached=editorAdapter(kind);const first=detached.bind('FIRST '+editorDocument,()=>oldCalls++,true);const second=detached.bind('LAST '+editorDocument,()=>newCalls++,true);await Promise.all([first,second]);document.body.append(detached.element);await settleEditor(detached,'LAST');
  check(editorRoots(detached.element).length===1&&!editorRoots(detached.element).some(e=>e.textContent?.includes('FIRST')),kind+' two initial binds did not supersede');
  detached.element.recycle();await frame();return [kind+' '+mode+' cold retired A→actual pool B, read-only, reconnect and two initial binds'];
}

export async function verifyEditorsWarm():Promise<string[]> {
  const results:string[]=[];
  for(const kind of ['code','codemirror','rich','prosemirror','html','markdown'] as const) {
    const adapter=editorAdapter(kind);await adapter.bind('WARM '+editorDocument,()=>{},kind!=='code'&&kind!=='markdown');document.body.append(adapter.element);await settleEditor(adapter,'WARM');
    check(editorRoots(adapter.element).length===1,kind+' normal view cardinality');await adapter.bind('NEW '+editorDocument,()=>{},false);await settleEditor(adapter,'NEW');
    check(editorRoots(adapter.element).length===1&&!deepElements(adapter.element).some(e=>e.getAttribute('contenteditable')==='true'),kind+' editable→read-only replacement failed');adapter.element.recycle();await frame();results.push(kind+' real vendor normal/current read-only replacement');
  }
  return results;
}
