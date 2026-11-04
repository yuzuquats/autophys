import { SliderInput } from './slider-input';
import { GridLayout } from '../grid/grid-layout';
export function verifyNumericInputs():string[] {
  for(const minWidthPx of [0,NaN,Infinity,-1,Number.MIN_VALUE,1e-300]) {
    const grid=GridLayout.make();let rejected=false;try{grid.bind({minWidthPx,inlineSpacingPx:4,blockSpacingPx:4});}catch(e){rejected=e instanceof RangeError;}if(!rejected)throw new Error('Grid invalid public geometry accepted');grid.recycle();
  }
  for(const [min,max,step] of [[1e16,1e16+2,.5],[0,Infinity,1],[0,100,.000001],[0,1,0],[0,1,NaN],[1,1,1]]) {
    const input=SliderInput.make();let rejected=false;try{input.bind({min,max,step});}catch(e){rejected=e instanceof RangeError;}if(!rejected)throw new Error('Slider invalid/dense public snaps accepted');input.recycle();
  }
  const defaults=SliderInput.make();defaults.bind({value:50});if(defaults.value!==50)throw new Error('Default Slider changed');defaults.bind({min:0,max:1,step:.25,value:.5});if(Number(defaults.value)!==.5)throw new Error('Modest Slider snaps changed');defaults.recycle();
  if(GridLayout.generateColumnState(2,800,4).columnWidth!==398)throw new Error('Ordinary Grid geometry changed');
  return ['Grid malformed geometry rejected before allocation','Slider malformed/dense snaps rejected and ordinary defaults compatible'];
}
