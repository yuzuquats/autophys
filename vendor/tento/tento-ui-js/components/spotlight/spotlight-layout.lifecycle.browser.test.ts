import {SpotlightLayout} from './spotlight-layout';
import {Spotlight} from './spotlight';
import {SpotlightRow} from './spotlight-row';
import {Focus} from '../../ui/focus';
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
const check=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
export async function verifySpotlightLifetime():Promise<string[]>{
 let old=0,current=0;const mount=document.createElement('div');document.body.append(mount);const s=SpotlightLayout.make();const opts:SpotlightLayout.MountOptions={placeholder:'Commands',focusZIndex:6000,measureHeight:false,onFocus:()=>{},onBlur:()=>old++,onQuery:()=>old++,onDismiss:()=>old++};const dispose=s.mountIn(mount,opts);s.focusSearch();const oldRow=document.createElement('button');oldRow.textContent='Retired result';s.setResults([{$e:oldRow,onSelect:()=>old++}],[]);const sibling=document.createElement('button');sibling.textContent='Live sibling';document.body.append(sibling);sibling.focus();s.recycle();await frame();await new Promise(r=>setTimeout(r,220));check(!s.isConnected,'Spotlight instance recycle left mounted');check(Focus.activeDeep()===sibling,'Retired selection/focus stole sibling focus');check(old===0,'Retired mount timer fired');
 const b=SpotlightLayout.make();check(b===s,'Spotlight actual pool reuse missing');b.mountIn(mount,{...opts,onQuery:()=>current++,onDismiss:()=>current++});oldRow.dispatchEvent(new PointerEvent('pointerenter'));await b.emitCommand(oldRow);check(current===0&&old===0,'Retired row reached successor');b.setSearchContent('current');b.shadowRoot!.querySelector('#searchbar')!.dispatchEvent(new Event('input'));check(Number(current)===1,'Current query callback');const before=b.isConnected;dispose();check(b.isConnected===before,'Old mount disposer changed successor');const currentDispose=b.mountIn(mount,{...opts,onQuery:()=>current++});currentDispose();check(b.isConnected,'Explicit mount disposal lost persistent mounting contract');SpotlightLayout.recycle(b);await frame();check(!b.isConnected,'Static Spotlight recycle left connected');const c=SpotlightLayout.make();check(c===b,'Static Spotlight pool identity');c.recycle();mount.remove();sibling.remove();await frame();await verifySpotlightReconnect();return ['Spotlight reconnect preserves row and mount bindings while retiring pending connection effects','Spotlight instance/static recycling and real pool reuse remove owned effects','Pending selection/mount timers and retained rows exclude successor; explicit disposer preserves mounting'];
}

async function verifySpotlightReconnect(): Promise<void> {
  const $mount = document.createElement('div');
  const $outside = document.createElement('button');
  document.body.append($mount, $outside);
  const $layout = SpotlightLayout.make();
  let commands = 0, completions = 0, blurs = 0, retired = 0;
  let finishPending: EmptyFunction = () => {};
  const pending = new Promise<void>(resolve => { finishPending = resolve; });
  const dispose = $layout.mountIn($mount, {
    placeholder: 'Reconnect', focusZIndex: 6000, measureHeight: true,
    onFocus: () => {}, onBlur: () => { blurs++; }, onQuery: () => {}, onDismiss: () => { completions++; },
  });
  const results = (): Spotlight.SearchResult[] => [
    { entry: { name: 'First', priority: 0, searchTerms: [], command: async () => { commands++; } }, score: 0 },
    { entry: { name: 'Second', priority: 0, searchTerms: [], command: async () => { commands++; } }, score: 0 },
  ];
  try {
    $layout.setResults([], results());
    await frame();
    const rows = [...$layout.querySelectorAll<SpotlightRow>('std-spotlight-row')];
    const $second = rows[1];
    const retiredPointerUp = $second.onpointerup;
    $layout.remove();
    $mount.append($layout);
    await frame();
    $second.dispatchEvent(new PointerEvent('pointerenter'));
    check($second.ariaSelected === 'true' && rows[0].ariaSelected === 'false', 'Reconnected Spotlight result hover became inert');
    $second.dispatchEvent(new PointerEvent('pointerup'));
    await frame();
    check(commands === 1 && completions === 1, 'Reconnected Spotlight standard pointer selection became inert');
    check(parseFloat($mount.style.height) > 0, 'Reconnected Spotlight mount height did not resume');

    $layout.focusSearch();
    $outside.focus();
    $layout.remove();
    $mount.append($layout);
    await new Promise(resolve => setTimeout(resolve, 220));
    check(blurs === 0 && $second.parentElement === $layout, 'Previous connection blur timer cleared reconnected Spotlight results');
    $layout.focusSearch();
    $outside.focus();
    await new Promise(resolve => setTimeout(resolve, 220));
    check(Number(blurs) === 1 && $layout.children.length === 0, 'Reconnected Spotlight current mount blur callback became inert');

    $layout.setResults([], [{ entry: { name: 'Pending', priority: 0, searchTerms: [], command: () => pending }, score: 0 }]);
    const $pendingRow = $layout.querySelector<SpotlightRow>('std-spotlight-row')!;
    const completedBefore = completions;
    const oldCommand = $layout.emitCommand($pendingRow);
    $layout.remove();
    $mount.append($layout);
    finishPending();
    await oldCommand;
    check(completions === completedBefore, 'Previous connection async command dismissed the reconnected Spotlight');

    const $retired = document.createElement('button');
    $layout.setResults([{ $e: $retired, onSelect: () => { retired++; } }], []);
    const retiredHover = $retired.onpointerenter;
    $layout.setResults([], results());
    await frame();
    $layout.remove();
    $mount.append($layout);
    await frame();
    const $selected = $layout.querySelector('[aria-selected=true]');
    const commandsBefore = commands;
    retiredPointerUp?.call($second, new PointerEvent('pointerup'));
    retiredHover?.call($retired, new PointerEvent('pointerenter'));
    await $layout.emitCommand($retired);
    await frame();
    check(commands === commandsBefore && retired === 0 && $layout.querySelector('[aria-selected=true]') === $selected, 'Reconnected Spotlight restored a retired result handler');
  } finally {
    finishPending();
    dispose();
    SpotlightLayout.recycle($layout);
    $mount.remove();
    $outside.remove();
    await frame();
  }
}
