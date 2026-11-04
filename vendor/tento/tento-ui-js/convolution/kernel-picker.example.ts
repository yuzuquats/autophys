import "./kernel-picker";

import { KernelPicker } from "./kernel-picker";
import { Kernels } from "./kernels";
import { Storybook } from "../ui/storybook";

const items = [
  {
    kernelFn: Kernels.gaussian(100),
    halfWidth: 100,
    color: "var(--blue)",
    title: "Gaussian",
    description: "Bell curve with smooth, infinite tails",
  },
  {
    kernelFn: Kernels.hamming(100),
    halfWidth: 100,
    color: "var(--red)",
    title: "Hamming",
    description: "Window function with reduced side lobes",
  },
  {
    kernelFn: Kernels.epanechnikov(100),
    halfWidth: 100,
    color: "var(--orange)",
    title: "Epanechnikov",
    description: "Optimal for mean squared error estimation",
  },
  {
    kernelFn: Kernels.boxcar(100),
    halfWidth: 100,
    color: "var(--green)",
    title: "Boxcar",
    description: "Uniform weight within the window",
  },
];

export class KernelPickerStoryBook extends Storybook.Default {
  title(): string {
    return "Kernel Picker";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "All Kernels",
        render: () => {
          let selectedIndex = 0;
          const $picker = KernelPicker.make();
          const updatePicker = (): void => {
            $picker.bind({
              items,
              selectedIndex,
              onChange: (index) => {
                selectedIndex = index;
                updatePicker();
              },
            });
          };
          updatePicker();
          return $picker.assignStyles({
            width: "100%",
            maxWidth: "400px",
          });
        },
      },
      {
        title: "Small",
        render: () => {
          let selectedIndex = 0;
          const $picker = KernelPicker.make();
          const updatePicker = (): void => {
            $picker.bind({
              items,
              selectedIndex,
              onChange: (index) => {
                selectedIndex = index;
                updatePicker();
              },
            });
          };
          updatePicker();
          return $picker.assignStyles({
            width: "100%",
            maxWidth: "280px",
          });
        },
      },
    ];
  }
}
