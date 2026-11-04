import { Anchor } from './anchor';
import { Popover } from './popover/popover';
import { SidebarSectionContainer } from './sidebar/sidebar-section-container';
import { Plot, PlotTooltip } from './plot';
import { Table } from './table/table';
import { Focus } from '../ui/focus';

const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const check = (value: boolean, message: string) => { if (!value) throw new Error(message); };

export async function verifyAssignedFocus(): Promise<string[]> {
  const results:string[]=[];
  for(const kind of ['inert','disabled','hidden','nested-shadow-slot','all-inert']) {
    const invoker = document.createElement('button'); document.body.append(invoker); invoker.focus();
    const content = document.createElement('div'); content.attachShadow({mode:'open'}).append(document.createElement('slot'));
    const unavailable=kind==='disabled'?document.createElement('fieldset'):document.createElement('div');
    if(unavailable instanceof HTMLFieldSetElement)unavailable.disabled=true;
    else if(kind==='hidden')unavailable.hidden=true;
    else unavailable.inert=true;
    unavailable.append(document.createElement('button'));content.append(unavailable);
    const enabled=document.createElement('button');enabled.textContent='Enabled action';
    if(kind==='nested-shadow-slot') {const nested=document.createElement('div');nested.attachShadow({mode:'open'}).append(document.createElement('slot'));const second=document.createElement('div');second.attachShadow({mode:'open'}).append(document.createElement('slot'));second.append(enabled);nested.append(second);content.append(nested);}
    else if(kind!=='all-inert')content.append(enabled);
    const handle=Popover.show({$anchor:invoker,$content:()=>content,role:'dialog',label:'Assigned tree',arrow:false,placement:null,onDismiss:null});
    try {await frame();check(Focus.activeDeep()===(kind==='all-inert'?handle.$popover:enabled),'Assigned '+kind+' ancestry blocked focus entry/fallback');}
    finally {handle.dismiss();invoker.remove();}
    results.push('Popover '+kind+' assigned ancestry and successful focus');
  }
  return results;
}

export async function verifySidebarFactory(): Promise<string[]> {
  const section = SidebarSectionContainer.make();
  check(section instanceof SidebarSectionContainer, 'Fresh public SidebarSectionContainer.make is not registered class');
  const native = document.createElement('std-sidebar-section-container');
  check(native instanceof SidebarSectionContainer, 'Native fresh SidebarSectionContainer constructor failed');
  document.body.append(section); section.style.height='300px'; const child=document.createElement('div'); child.style.height='80px'; section.append(child);
  try {await frame(); check(getComputedStyle(section).getPropertyValue('--p-animation-duration').trim() === '0.45s', 'Sidebar duration changed');
    section.focusOnSection(true,child,()=>{},false); await frame(); check(section.$focusedSection === child && child.hasAttribute('expanded'),'Sidebar did not expand');
    section.focusOnSection(false,child,()=>{},false); await frame(); check(section.$focusedSection == null,'Sidebar did not collapse');
    section.remove(); document.body.append(section); await frame(); section.recycle(); await frame();
    const next=SidebarSectionContainer.make(); check(next === section,'Sidebar actual pool reuse missing'); check(next.$focusedSection == null,'Sidebar retains retired focused section'); next.recycle(); await frame();
  } finally { section.remove(); }
  return ['Sidebar fresh constructor, duration, focus, reconnect and actual reuse'];
}

export async function verifyInstanceAnchor(): Promise<string[]> {
  const results:string[]=[]; let dismissed=0; const contents:HTMLElement[]=[];
  const props:Anchor.Props={contentProvider:()=>{const c=document.createElement('button'); c.textContent='Popup action'; contents.push(c);return {$content:c,onDismiss:()=>dismissed++};}};
  for(const mode of ['rebind','detach','recycle']) {
    const a=Anchor.makeWith(document.createElement('span'),props); document.body.append(a);
    a.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await frame();
    check(contents.at(-1)?.isConnected===true,'Anchor instance popup not mounted'); const old=contents.at(-1)!; const before=dismissed;
    if(mode==='rebind') a.bind(document.createElement('span'),props); else if(mode==='detach')a.remove(); else a.recycle();
    await frame(); check(!old.isConnected && dismissed===before+1,'Anchor '+mode+' did not retire instance popup exactly once');
    if(mode==='detach') {document.body.append(a);a.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));await frame();check(contents.at(-1)?.isConnected===true,'Anchor reconnect not operable');}
    if(mode!=='recycle')a.recycle(); await frame(); const b=Anchor.makeWith(document.createElement('span'),props);check(b===a,'Anchor actual pool reuse missing'); b.recycle();await frame();results.push('Anchor instance '+mode+' ownership and actual reuse');
  }
  const a=Anchor.makeWith(document.createElement('span'),props), b=Anchor.makeWith(document.createElement('span'),props);document.body.append(a,b);
  a.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));const old=contents.at(-1)!;
  b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));const current=contents.at(-1)!;
  check(!old.isConnected&&current.isConnected,'Anchor singleton policy changed');a.remove();check(current.isConnected,'Retiring old Anchor dismissed sibling');a.recycle();b.recycle();await frame();
  results.push('Anchor singleton sibling ownership');return results;
}

export async function verifyPlotInstanceRecycle(): Promise<string[]> {
  const props:Plot.Props={f:{r:{start:0,end:1},data:()=>({x:0,y:.5})},yRange:{start:0,end:1},tooltipsProvider:()=>({title:'Owned tooltip',date:'',value:'',change:''})};
  const p=Plot.make();p.style.display='block';p.style.width='300px';p.style.height='200px';p.bind(props);document.body.append(p);await frame();await frame();
  const canvas=p.shadowRoot!.querySelector('canvas')!; const before=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
  let rejected=false;try{p.bind({...props,yRange:{start:1,end:1}});}catch(e){rejected=e instanceof RangeError;}check(rejected,'Plot invalid public bind did not reject');
  await frame();check(canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data.every((v,i)=>v===before[i]),'Plot invalid bind changed valid canvas');
  const hover=(plot:Plot) => {const c=plot.shadowRoot!.querySelector('canvas')!;const rect=c.getBoundingClientRect();const event=new PointerEvent('pointermove',{clientX:rect.left+150,clientY:rect.top+150,bubbles:true,composed:true});Object.defineProperties(event,{offsetX:{value:150},offsetY:{value:150}});c.dispatchEvent(event);};
  hover(p);await frame();const tooltip=PlotTooltip.instance.maybeGet();check(tooltip?.hasAttribute('shown')===true,'Mounted Plot was not actually hovered');
  p.dismissTooltip();
  const sibling=Plot.make();sibling.style.display='block';sibling.style.width='300px';sibling.style.height='200px';sibling.bind(props);document.body.append(sibling);await frame();await frame();hover(sibling);await frame();check(tooltip?.hasAttribute('shown')===true,'Second Plot did not own tooltip');
  p.recycle();check(!p.isConnected,'Plot instance recycle left mounted');await new Promise(r=>setTimeout(r,350));check(tooltip?.hasAttribute('shown')===true,'Retiring old Plot hid live sibling tooltip');sibling.recycle();await frame();
  // Consume the sibling's pool entry first, then observe actual reuse of p.
  const first=Plot.make(),next=Plot.make();check(next===p,'Plot instance did not join class pool');next.bind({...props,tooltipsProvider:()=>({title:'New',date:'',value:'',change:''})});document.body.append(next);await frame();next.recycle();first.recycle();await frame();return ['Plot actual hovered instance recycle, sibling tooltip ownership, pool reuse and invalid-bind preservation'];
}

type Row={id:string,value:string};
export function tableModel():Table.ViewModel<Row> {
  return Table.ViewModel.makeDefault({columns:[{id:'value',label:'Value',make:()=>document.createElement('span'),bind:(e,item)=>{e.textContent=item.value;},sortComparator:(a,b)=>a.value.localeCompare(b.value)}]});
}
export async function verifyTableSubscriptions():Promise<string[]> {
  const a=tableModel();const table=Table.makeTyped<Row>();table.style.width='800px';table.style.height='300px';table.bind(a);document.body.append(table);await frame();await frame();
  table.remove();document.body.append(table);await frame();a.updateStyle({containerMarginInline:31});check(table.style.getPropertyValue('--padding-inline')==='31px','Table reconnect lost model layout subscription');
  table.recycle();await frame();const next=Table.makeTyped<Row>();check(next===table,'Table actual reuse missing');const b=tableModel();next.bind(b);const previous=next.style.getPropertyValue('--padding-inline');a.updateStyle({containerMarginInline:77});check(next.style.getPropertyValue('--padding-inline')===previous,'Retired model reached pooled Table');b.updateStyle({containerMarginInline:19});check(next.style.getPropertyValue('--padding-inline')==='19px','Current detached model not operable');next.recycle();await frame();
  const detached=Table.makeTyped<Row>();detached.bind(a);detached.recycle();await frame();const pooled=Table.makeTyped<Row>();check(pooled===detached,'Detached Table reuse missing');a.updateStyle({containerMarginInline:88});check(pooled.style.getPropertyValue('--padding-inline')==='','Detached recycle retained subscriptions');pooled.recycle();await frame();return ['Table model reconnect and detached recycle subscriptions'];
}
