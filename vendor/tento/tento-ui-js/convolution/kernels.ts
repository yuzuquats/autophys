// Convolution kernels are owned by @tento-core (the single source of truth, shared with the
// chart/data layers). This storybook-only convolution gallery re-exports them rather than
// duplicating the math — kept as a thin shim so the local `./kernels` import sites stay stable.
export { type KernelFunction, Kernels } from "@tento-core/convolution/kernels";
