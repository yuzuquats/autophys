globalThis.requestIdleCallback =
  globalThis.requestIdleCallback ||
  ((cb) => {
    const start = Date.now();
    return setTimeout(() => {
      cb({
        didTimeout: false,
        timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
      });
    }, 1);
  });

globalThis.cancelIdleCallback =
  globalThis.cancelIdleCallback ||
  ((n: number) => {
    clearTimeout(n);
  });
