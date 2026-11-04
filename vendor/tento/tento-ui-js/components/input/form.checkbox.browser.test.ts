import {Form} from './form';
import {Checkbox} from '../controls/checkbox';
const frame=()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
const check=(ok:boolean,message:string)=>{if(!ok)throw new Error(message);};
export async function verifyCheckboxRetirement():Promise<string[]>{
 let old=0,current=0;const f=Form.make();const props:Form.Props={inputs:[{name:'check',type:'checkbox',label:'Current label',checked:false}],onChange:()=>old++};f.bind(props);document.body.append(f);await frame();const label=f.querySelector('label')!;const checkbox=f.querySelector<Checkbox>('std-checkbox')!;
 // The trusted label path is captured separately; property invocation isolates retained callback ownership.
 const pointer=Reflect.get(label,'onpointerup');const event=new PointerEvent('pointerup',{button:0,bubbles:true});pointer?.call(label,event);check(old===1&&f.value('check')==='true','Current label callback count/value');
 f.bind({...props,onChange:()=>current++});await frame();pointer?.call(label,event);check(old===1&&current===0&&f.value('check')==='false','Retired rebind label changed current occupant');
 const retired=f.querySelector('label')!;const retiredCallback=Reflect.get(retired,'onpointerup');f.recycle();await frame();const b=Form.make();check(b===f,'Form actual checkbox pool reuse');b.bind({...props,onChange:()=>current++});document.body.append(b);await frame();retiredCallback?.call(retired,event);check(current===0&&b.value('check')==='false','Pooled retired label changed successor');
 b.bind({...props,inputs:[{name:'check',type:'checkbox',label:'Disabled',disabled:true}],onChange:()=>current++});await frame();const disabled=b.querySelector('label')!;Reflect.get(disabled,'onpointerup')?.call(disabled,event);check(current===0&&b.value('check')==='false','Disabled label notified');
 b.bind({...props,onChange:()=>current++});await frame();b.remove();document.body.append(b);await frame();const direct=b.querySelector<Checkbox>('std-checkbox')!;direct.setChecked(true);direct.onChange?.(true);check(current===1&&b.value('check')==='true','Current direct/reconnected checkbox callback');b.recycle();await frame();void checkbox;
 return ['Custom-checkbox label exactly once; old rebind/recycle labels silent with actual Form reuse','Disabled label and current direct Checkbox after reconnect preserve values'];
}
