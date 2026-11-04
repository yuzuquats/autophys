export class SizeGate {
  private resolver: Option<EmptyFunction>;
  private promise: Promise<void> = new Promise(
    (resolve) => (this.resolver = resolve),
  );
  private size: Option<Size>;

  get currentSize(): Option<Size> {
    return this.size;
  }

  async waitForSize(): Promise<Size> {
    await this.promise;
    return this.size!;
  }

  resolve(size: Size): void {
    this.size = size;
    this.resolver!();
  }
}
