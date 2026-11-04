import { Form } from './form';
const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
export async function verifyFormRetirement():Promise<string[]> {
  let oldCalls=0,newCalls=0;
  const form=Form.make();form.bind({title:'First',inputs:[{name:'old',type:'text',value:'old'}],onChange:()=>oldCalls++});
  form.bind({title:'Latest',inputs:[{name:'latest',type:'text',value:'current'}],onChange:()=>oldCalls++});document.body.append(form);await frame();
  if(!form.textContent?.includes('Latest')||form.textContent?.includes('First')||form.value('latest')!=='current'||form.value('old')!=='')throw new Error('Form newer queued binding did not win');
  const oldInput=form.querySelector('std-text-input')?.shadowRoot?.querySelector('input');if(oldInput==null)throw new Error('Form current text input missing');
  form.setError('RETIRED_ERROR');form.recycle();await frame();const next=Form.make();if(next!==form)throw new Error('Form actual pool reuse missing');
  next.bind({title:'Successor',inputs:[{name:'next',type:'text',value:'new'}],onChange:()=>newCalls++});document.body.append(next);await frame();
  if(next.textContent?.includes('RETIRED_ERROR')||next.textContent?.includes('Latest')||next.value('latest')!=='')throw new Error('Form retired error/rows survived into new occupant');
  oldInput.dispatchEvent(new Event('input',{bubbles:true}));if(oldCalls!==0||newCalls!==0)throw new Error('Retained old Form input notified an occupant');
  const input=next.querySelector('std-text-input')?.shadowRoot?.querySelector('input');if(input==null)throw new Error('Form successor input missing');input.value='updated';input.dispatchEvent(new Event('input',{bubbles:true}));if(Number(newCalls)!==1||next.value('next')!=='updated')throw new Error('Form current input did not notify once');
  next.remove();document.body.append(next);await frame();input.value='reconnected';input.dispatchEvent(new Event('input',{bubbles:true}));if(Number(newCalls)!==2||next.value('next')!=='reconnected')throw new Error('Form reversible reconnect lost current callback/value');
  next.recycle();await frame();return ['Form newest queued binding and actual pooled error/callback retirement','Form visible current input and reversible reconnect'];
}
