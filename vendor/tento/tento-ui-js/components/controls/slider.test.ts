import { Slider } from "./slider";
{
  const s = new Slider.State(
    {
      start: 100,
      end: 400,
    },
    150,
    150,
    10,
  );

  const l = s.layout();
  const newS = s.withProgressPx(l.progressPx);
  const newL = newS.layout();

  // console.table({ l, newL });
}
