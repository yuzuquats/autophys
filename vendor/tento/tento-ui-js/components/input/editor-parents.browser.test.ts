import {HtmlEditorInput} from './html-editor-input';
import {HtmlEditorModal} from './html-editor-modal';
import {HtmlEditor} from '../html-editor';
import {editorRoots} from '../code/editor-retirement.browser.test';
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const check=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
async function ready(e:Element,marker:string):Promise<void>{const deadline=performance.now()+6000;while(performance.now()<deadline){if(editorRoots(e).some(r=>r.textContent?.includes(marker)))return;await frame();}throw new Error('Parent current child never ready: '+marker);}
export async function verifyParentCold(kind:'input'|'modal',mounted:boolean):Promise<string[]>{
 let old=0,current=0;const C=kind==='input'?HtmlEditorInput:HtmlEditorModal;const a=C.make();
 if(a instanceof HtmlEditorInput)a.bind({html:'<p>RETIRED_PARENT_A</p>',onChange:()=>old++});else a.bind('Retired A','<p>RETIRED_PARENT_A</p>',()=>old++);
 if(mounted)document.body.append(a);a.recycle();await frame();const b=C.make();check(a===b,'Parent actual pool reuse '+kind);
 if(b instanceof HtmlEditorInput)b.bind({html:'<p>CURRENT_PARENT_B</p>',onChange:()=>current++});else b.bind('Current B','<p>CURRENT_PARENT_B</p>',()=>current++);
 // Intentionally detached binding must be supported before insertion.
 await ready(b,'CURRENT_PARENT_B');check(editorRoots(b).length===1&&!editorRoots(b).some(r=>r.textContent?.includes('RETIRED_PARENT_A')),'Retired child painted parent successor');check(old===0&&current===0,'Load notified parent delegate');document.body.append(b);await frame();b.remove();check(editorRoots(b).length===0,'Parent detach retained view');document.body.append(b);await ready(b,'CURRENT_PARENT_B');
 if(b instanceof HtmlEditorModal){const child=b.shadowRoot!.querySelector<HtmlEditor>('#html-editor')!;child.value='<p>USER_COMMIT</p>';await frame();await frame();const save=b.shadowRoot!.querySelector<HTMLButtonElement>('#save-button')!;save.click();save.click();check(Number(current)===1&&old===0,'Modal saved more than once or stale delegate');check(editorRoots(b).length===0,'Modal save did not retire view');}
 else {check(b.html==='<p>CURRENT_PARENT_B</p>','Current read-only value changed');check(editorRoots(b).every(r=>r.contentEditable==='false'),'Input preview not read-only');}
 b.recycle();await frame();check(editorRoots(b).length===0,'Recycled parent retains vendor child');return [kind+' '+(mounted?'mounted':'initially detached')+' cold A→actual pool B, newest detached bind/reconnect/current callback and child retirement'];
}
export async function verifyModalEarlyExit():Promise<string[]>{
 let saved=0;let value:Option<string>;const m=HtmlEditorModal.make();m.bind('Save before readiness','<p>INITIAL_BEFORE_LOAD</p>',html=>{saved++;value=html;});const save=m.shadowRoot!.querySelector<HTMLButtonElement>('#save-button')!;const oldClick=save.onclick;save.click();save.click();check(saved===1&&value==='<p>INITIAL_BEFORE_LOAD</p>','Early save current value/cardinality');m.bind('Successor','<p>SUCCESSOR</p>',()=>saved++);oldClick?.call(save,new MouseEvent('click'));check(saved===1,'Old modal save affected successor');m.shadowRoot!.querySelector<HTMLButtonElement>('#cancel-button')!.click();await sleep(1700);check(saved===1&&editorRoots(m).length===0,'Cancel before loading retained child/notified');m.recycle();await frame();return ['Modal cold save/cancel and retained save callback retire child/current value exactly once'];
}
