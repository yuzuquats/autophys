import { TwoWaySlider, ThickTwoWaySlider } from './two-way-slider';
import { SwatchRow } from '../swatch-row/swatch-row';
import { Stepper, StepperHorizontal } from '../stepper';

const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
export function keyboardFixtures(): HTMLElement[] {
  const controls:HTMLElement[]=[];
  for (const Slider of [TwoWaySlider, ThickTwoWaySlider]) {
    const slider = Slider.makeWith({min:0,max:100,minWidth:10,rangeStart:20,rangeEnd:60,showTooltip:false,onRangeChanged:(start,end)=>{slider.dataset.calls=String(Number(slider.dataset.calls??0)+1);slider.dataset.range=`${start},${end}`;}});
    slider.style.width='400px';slider.dataset.calls='0';controls.push(slider);
  }
  const swatches=SwatchRow.makeWith({swatches:[{background:'red',label:'Red'},{background:'blue',label:'Blue'}],onSelect:i=>{swatches.dataset.calls=String(Number(swatches.dataset.calls??0)+1);swatches.dataset.selected=String(i);}});swatches.dataset.calls='0';controls.push(swatches);
  for (const StepperClass of [Stepper,StepperHorizontal]) {
    const stepper=StepperClass.make(); stepper.onSelect=key=>{stepper.dataset.calls=String(Number(stepper.dataset.calls??0)+1);stepper.dataset.selected=key;};stepper.dataset.calls='0';
    stepper.bind({steps:[{title:'First step',body:null,marker:null,meta:null,tone:null,current:true,muted:false,railAfter:'solid',key:'first'},{title:'Disabled step',body:null,marker:null,meta:null,tone:null,current:false,muted:false,railAfter:'none',key:'disabled',disabled:true},{title:'Passive step',body:null,marker:null,meta:null,tone:null,current:false,muted:false,railAfter:'none',key:null}]});controls.push(stepper);
  }
  return controls;
}
export async function verifySelectionKeyboard():Promise<string[]> {
  const fixtures=keyboardFixtures();document.body.append(...fixtures);await frame();const results:string[]=[];
  try {
    for(const slider of fixtures.slice(0,2)) {
      const handles=[...slider.shadowRoot!.querySelectorAll<HTMLElement>('[role=slider]')];check(handles.length===2,'Both thumbs must expose sliders');
      check(handles.every(h=>h.tabIndex===0&&h.getAttribute('aria-label')!=null),'Slider thumbs lack reachable names');
      const left=handles[0],right=handles[1];left.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));check(left.getAttribute('aria-valuenow')==='50','Range start exceeded minimum endpoint spacing');
      left.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));check(slider.dataset.calls==='1','Endpoint callback repeated at unchanged boundary');right.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));check(right.getAttribute('aria-valuenow')==='60'&&slider.dataset.calls==='1','Range end violated separation or duplicate callback');
      const props={min:0,max:100,minWidth:10,rangeStart:20,rangeEnd:60,disabled:true,showTooltip:false,onRangeChanged:()=>{throw new Error('Disabled slider emitted');}};
      if(slider instanceof TwoWaySlider||slider instanceof ThickTwoWaySlider)slider.bind(props);
      left.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));check(left.tabIndex===-1&&left.getAttribute('aria-valuenow')==='20','Disabled slider changed');results.push(slider.localName+' bounded endpoints, current callback and disabled keys');
    }
    const swatch=fixtures[2] as SwatchRow;const old=swatch.shadowRoot!.querySelector<HTMLButtonElement>('button')!;old.click();check(swatch.dataset.calls==='1'&&old.getAttribute('aria-pressed')==='true','Swatch keyboard click selection missing');
    swatch.bind({swatches:[{background:'green',label:'Green'}],onSelect:()=>{throw new Error('Old square reached successor');}});old.click();swatch.bind({swatches:[{background:'green'}]});check(swatch.shadowRoot!.querySelector('button')==null,'Passive swatch became keyboard button');results.push('Swatch native button selection and retired/passive replacement');
    for(const s of fixtures.slice(3)) {
      const action=s.shadowRoot!.querySelector<HTMLElement>('.step-head[role=button]')!;action.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));check(s.dataset.calls==='1'&&s.dataset.selected==='first','Keyed step Space did not select once');
      const disabled=s.shadowRoot!.querySelector<HTMLElement>('[aria-disabled=true]')!;disabled.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));check(s.dataset.calls==='1'&&disabled.tabIndex===-1,'Disabled step selected');results.push(s.localName+' keyed Space selection and nonselectable rows');
    }
  } finally {for(const f of fixtures){if(f instanceof TwoWaySlider||f instanceof ThickTwoWaySlider||f instanceof SwatchRow||f instanceof Stepper||f instanceof StepperHorizontal)f.recycle();else f.remove();}await frame();}
  return results;
}
