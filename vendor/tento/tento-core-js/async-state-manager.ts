export class AsyncStateManager<E, P> {
  private entities: Map<E, P> = new Map();
  bind(entity: E, p: P): (p: P) => boolean {
    this.entities.set(entity, p);
    return (maybeNewProp) => {
      const stillValid = this.entities.get(entity) === maybeNewProp;
      return stillValid;
    };
  }
  clear(entity: E) {
    this.entities.delete(entity);
  }
}
