import { Storybook } from "../../ui/storybook";
import { Toast } from "../toast/toast";
import { SliderInput } from "./slider-input";

export class SliderInputStoryBook extends Storybook.Default {
  title(): string {
    return "Slider Input";
  }

  tags(): string[] {
    return ["std-slider-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "With Label",
        render: () => {
          const $slider = SliderInput.make();
          $slider.bind({
            label: "Volume",
            value: 50,
          });
          $slider.onChange = () => {
            Toast.info(`Value: ${$slider.value}`);
          };
          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "With Label and Caption",
        render: () => {
          const $slider = SliderInput.make();
          $slider.bind({
            label: "Brightness",
            caption: "Adjust the screen brightness level",
            value: 75,
          });
          $slider.onChange = () => {
            Toast.info(`Value: ${$slider.value}`);
          };
          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "With Description and Caption",
        render: () => {
          const $slider = SliderInput.make();
          $slider.bind({
            label: "Quality",
            description: "Higher quality uses more bandwidth",
            caption: "Current: High",
            value: 80,
            min: 0,
            max: 100,
            step: 20,
          });
          $slider.onChange = () => {
            Toast.info(`Value: ${$slider.value}`);
          };
          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "Required Field",
        render: () => {
          const $slider = SliderInput.make();
          $slider.bind({
            label: "Priority",
            required: true,
            value: 5,
            min: 1,
            max: 10,
            step: 1,
          });
          $slider.onChange = () => {
            Toast.info(`Value: ${$slider.value}`);
          };
          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "No Label (Control Only)",
        render: () => {
          const $slider = SliderInput.make();
          $slider.bind({
            value: 50,
          });
          $slider.onChange = () => {
            Toast.info(`Value: ${$slider.value}`);
          };
          return Storybook.fill($slider, "320px");
        },
      },
    ];
  }
}
