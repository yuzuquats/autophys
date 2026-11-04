import { nonnull } from "@tento-core/assert";

export type IDBPrimaryKeyIndexEvents = {
  onInserted: string;
  onDeleted: string;
  onUpdated: string;
};

export type IDBPrimaryKeyIndex<
  T extends Identifiable<ID> & Update,
  ID = Uuid,
  Update extends Omit<Partial<T>, "id"> = Omit<Partial<T>, "id">,
> = {
  find(id: Option<ID>): Option<T>;
  findUnwrap(id: ID): T;
  findAll(): T[];
  insert(t: T): T;
  update(
    id: ID,
    t: Update,
    whoUpdated: string,
  ): {
    from: T;
    to: T;
  };
  delete(id: ID): T;

  seeWhoUpdated(): Option<string>;
  popWhoUpdated(): Option<string>;
};

type DBEvent = {
  handled?: boolean;
};

export class DBPrimaryKeyIndex<
  T extends Identifiable<Id> & Update,
  Id = Uuid,
  Update extends Omit<Partial<T>, "id"> = Omit<Partial<T>, "id">,
> implements IDBPrimaryKeyIndex<T, Id, Update> {
  private baseIndex: Map<Id, T> = new Map();
  private whoUpdated: Option<string>;

  delegate: Option<{
    onInsert: (t: T) => void;
    onUpdate: (
      prevT: T,
      newT: T,
      delta: Update,
      whoUpdated: Option<string>,
    ) => void;
    onDelete: (t: T, whoUpdated: Option<string>) => void;
  }>;

  find(id: Option<Id>): Option<T> {
    if (!id) return null;
    return this.baseIndex.get(id);
  }

  findUnwrap(id: Id): T {
    return nonnull(this.baseIndex.get(id));
  }

  findAll(): T[] {
    return [...this.baseIndex.values()];
  }

  insert(t: T, notify: boolean = true, whoUpdated: Option<string> = null): T {
    this.baseIndex.set(t.id, t);
    this.whoUpdated = whoUpdated;
    notify && this.delegate?.onInsert(t);
    return t;
  }

  update(
    id: Id,
    t: Update,
    whoUpdated: string,
  ): {
    from: T;
    to: T;
  } {
    const from = {
      ...nonnull(this.baseIndex.get(id)),
    };
    const to = {
      ...nonnull(this.baseIndex.get(id)),
      ...t,
    };
    this.baseIndex.set(id, to);
    this.whoUpdated = whoUpdated;
    this.delegate?.onUpdate(from, to, t, whoUpdated);
    return {
      from,
      to,
    };
  }

  delete(id: Id, notify: boolean = true, whoUpdated: Option<string> = null): T {
    const prev = nonnull(this.baseIndex.get(id));
    this.whoUpdated = whoUpdated;
    this.baseIndex.delete(id);
    if (notify) {
      this.delegate?.onDelete(prev, whoUpdated);
    }
    return prev;
  }

  seeWhoUpdated(): Option<string> {
    return this.whoUpdated;
  }

  popWhoUpdated(): Option<string> {
    const ret = this.whoUpdated;
    this.whoUpdated = null;
    return ret;
  }

  bindToEventTarget(
    et: EventTarget,
    events: IDBPrimaryKeyIndexEvents,
    hooks?: Option<{
      onDelete?: (e: DBDeleteEvent<T>, ee: DBEvent) => Promise<void>;
      onInsert?: (e: DBInsertEvent<T>, ee: DBEvent) => Promise<void>;
      onUpdate?: (e: DBUpdateEvent<T>, ee: DBEvent) => Promise<void>;
    }>,
  ) {
    this.delegate = {
      onDelete: async (t, whoUpdated) => {
        const e = new DBDeleteEvent(events, t, whoUpdated);
        if (hooks?.onDelete) {
          const ee: DBEvent = {};
          await hooks.onDelete(e, ee);
          if (ee.handled) return;
        }
        et.dispatchEvent(e);
      },
      onInsert: async (t) => {
        const e = new DBInsertEvent(events, t);
        if (hooks?.onInsert) {
          const ee: DBEvent = {};
          await hooks.onInsert(e, ee);
          if (ee.handled) return;
        }
        et.dispatchEvent(e);
      },
      onUpdate: async (prevT, newT, delta, whoUpdated) => {
        const e = new DBUpdateEvent(events, prevT, newT, delta, whoUpdated);
        if (hooks?.onUpdate) {
          const ee: DBEvent = {};
          await hooks.onUpdate(e, ee);
          if (ee.handled) return;
        }
        et.dispatchEvent(e);
      },
    };
  }

  bindOnUpdateListener(
    et: EventTarget,
    events: IDBPrimaryKeyIndexEvents,
  ): (cb: (e: DBUpdateEvent<T>) => void) => void {
    // @ts-ignore
    return (cb) => et.addEventListener(events.onUpdated, cb);
  }

  bindOnInsertListener(
    et: EventTarget,
    events: IDBPrimaryKeyIndexEvents,
  ): (cb: (e: DBInsertEvent<T>) => void) => void {
    // @ts-ignore
    return (cb) => et.addEventListener(events.onInserted, cb);
  }

  bindOnDeleteListener(
    et: EventTarget,
    events: IDBPrimaryKeyIndexEvents,
  ): (cb: (e: DBDeleteEvent<T>) => void) => void {
    // @ts-ignore
    return (cb) => et.addEventListener(events.onDeleted, cb);
  }
}

export type DBIndexEmitsEvents<T> = {
  addOnUpdateListener: (cb: (e: DBUpdateEvent<T>) => void) => void;
  addOnInsertListener: (cb: (e: DBInsertEvent<T>) => void) => void;
  addOnDeleteListener: (cb: (e: DBDeleteEvent<T>) => void) => void;
};

export class DBInsertEvent<T> extends Event {
  inserted: T;
  constructor(keys: IDBPrimaryKeyIndexEvents, inserted: T) {
    super(keys.onInserted);
    this.inserted = inserted;
  }
}

export class DBUpdateEvent<T> extends Event {
  from: T;
  to: T;
  delta: Omit<Partial<T>, "id">;
  whoUpdated: Option<string>;
  constructor(
    keys: IDBPrimaryKeyIndexEvents,
    from: T,
    to: T,
    delta: Omit<Partial<T>, "id">,
    whoUpdated: Option<string>,
  ) {
    super(keys.onUpdated);
    this.from = from;
    this.to = to;
    this.delta = delta;
    this.whoUpdated = whoUpdated;
  }
}

export class DBDeleteEvent<T> extends Event {
  deleted: T;
  whoUpdated: Option<string>;
  constructor(
    keys: IDBPrimaryKeyIndexEvents,
    deleted: T,
    whoUpdated: Option<string>,
  ) {
    super(keys.onDeleted);
    this.deleted = deleted;
    this.whoUpdated = whoUpdated;
  }
}
