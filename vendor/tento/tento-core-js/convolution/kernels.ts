export type KernelFunction = (dt: number) => number;

export namespace Kernels {
  export function gaussian(halfWidth: number): KernelFunction {
    const sigma = halfWidth / 3;
    return (dt: number) => {
      if (Math.abs(dt) >= halfWidth) return 0;
      return Math.exp(-(dt * dt) / (2 * sigma * sigma));
    };
  }

  export function hamming(halfWidth: number): KernelFunction {
    return (dt: number) => {
      const normalized = Math.max(-1, Math.min(1, dt / halfWidth));
      return 0.54 + 0.46 * Math.cos(Math.PI * normalized);
    };
  }

  export function epanechnikov(halfWidth: number): KernelFunction {
    return (dt: number) => {
      if (Math.abs(dt) >= halfWidth) return 0;
      const normalized = dt / halfWidth;
      return 0.75 * (1 - normalized * normalized);
    };
  }

  export function boxcar(halfWidth: number): KernelFunction {
    return (dt: number) => {
      if (Math.abs(dt) >= halfWidth) return 0;
      return 1;
    };
  }
}
