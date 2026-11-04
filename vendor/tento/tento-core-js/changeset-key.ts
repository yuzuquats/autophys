const ACTOR_SYMBOL = Symbol("actor-id");

/**
 * Who made a write: stamped on the invalidations the write emits, so a
 * surface can recognise and skip its own echo.
 */
export class Actor {
  /**
   * The actor of a write whose caller has no echo of its own to recognise:
   * every subscriber — the writing surface included — hears the write's
   * invalidations as someone else's. Pass it where a verb requires an
   * `actor` and the caller holds none; it is never a surface's own actor.
   */
  static readonly EXTERNAL: Actor = new Actor("external");

  private readonly [ACTOR_SYMBOL]: symbol;

  /** An actor is a shared identity (a class's `ACTOR`, `Actor.EXTERNAL`), so it is frozen. */
  constructor(readonly name: string) {
    this[ACTOR_SYMBOL] = Symbol(name);
    Object.freeze(this);
  }

  equals(other: Actor): boolean {
    return this[ACTOR_SYMBOL] === other[ACTOR_SYMBOL];
  }
}

export class ChangesetKey {
  constructor(
    readonly actor: Actor,
    readonly key: string,
  ) {}

  equals(other: ChangesetKey): boolean {
    return this.actor.equals(other.actor) && this.key === other.key;
  }

  static make(actor: Actor, key: string): ChangesetKey {
    return new ChangesetKey(actor, key);
  }
}
