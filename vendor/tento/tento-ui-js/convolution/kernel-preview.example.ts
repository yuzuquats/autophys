import "./kernel-preview";

import { KernelPreview } from "./kernel-preview";
import { Kernels } from "./kernels";
import { Storybook } from "../ui/storybook";

export class ConvolutionGaussianStoryBook extends Storybook.Default {
  title(): string {
    return "Gaussian Kernel";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Preview",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.gaussian(100),
            halfWidth: 100,
            title: "Gaussian Kernel",
            color: "var(--blue)",
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
      {
        title: "Debug",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.gaussian(100),
            halfWidth: 100,
            title: "Gaussian Kernel",
            color: "var(--blue)",
            debug: true,
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
    ];
  }
}

export class ConvolutionHammingStoryBook extends Storybook.Default {
  title(): string {
    return "Hamming Kernel";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Preview",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.hamming(100),
            halfWidth: 100,
            title: "Hamming Kernel",
            color: "var(--red)",
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
      {
        title: "Debug",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.hamming(100),
            halfWidth: 100,
            title: "Hamming Kernel",
            color: "var(--blue)",
            debug: true,
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
    ];
  }
}

export class ConvolutionEpanechnikovStoryBook extends Storybook.Default {
  title(): string {
    return "Epanechnikov Kernel";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Preview",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.epanechnikov(100),
            halfWidth: 100,
            title: "Epanechnikov Kernel",
            color: "var(--orange)",
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
      {
        title: "Debug",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.epanechnikov(100),
            halfWidth: 100,
            title: "Epanechnikov Kernel",
            color: "var(--orange)",
            debug: true,
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
    ];
  }
}

export class ConvolutionBoxcarStoryBook extends Storybook.Default {
  title(): string {
    return "Boxcar Kernel";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Preview",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.boxcar(100),
            halfWidth: 100,
            title: "Boxcar Kernel",
            color: "var(--green)",
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
      {
        title: "Debug",
        render: () => {
          const $preview = KernelPreview.make();
          $preview.bind({
            kernelFn: Kernels.boxcar(100),
            halfWidth: 100,
            title: "Boxcar Kernel",
            color: "var(--green)",
            debug: true,
          });
          $preview.style.height = "300px";
          return $preview;
        },
      },
    ];
  }
}
