/** Resolve the ordered master rolls over all projects loaded for one host.
 * A project may itself contain projects. Roots alone get top-level rows;
 * preorder supplies each root's complete, indented reading sequence.
 */
export namespace ProjectGroups {
  export type Member = { slug: string; depth: number; ordinal: string };
  export type Groups = {
    parent: Map<string, string>;
    descendants: Map<string, Member[]>;
  };

  export function resolve(
    present: ReadonlySet<string>,
    rolls: ReadonlyMap<string, readonly string[]>,
  ): Groups {
    const parent = new Map<string, string>();
    const children = new Map<string, { slug: string; ordinal: number }[]>();
    for (const [master, roll] of rolls) {
      if (!present.has(master)) continue;
      roll.forEach((slug, index) => {
        if (!present.has(slug) || parent.has(slug)) return;
        // Refuse the edge that closes a cycle. The remaining component still
        // has a root, so malformed metadata cannot make its work disappear.
        let ancestor: Option<string> = master;
        while (ancestor != null) {
          if (ancestor === slug) return;
          ancestor = parent.get(ancestor);
        }
        parent.set(slug, master);
        const list = children.get(master) ?? [];
        list.push({ slug, ordinal: index + 1 });
        children.set(master, list);
      });
    }
    const descendants = new Map<string, Member[]>();
    for (const root of present) {
      if (parent.has(root)) continue;
      const members: Member[] = [];
      const pending = [...(children.get(root) ?? [])].reverse().map(child => ({
        slug: child.slug, depth: 1, ordinal: String(child.ordinal),
      }));
      while (pending.length > 0) {
        const member = pending.pop();
        if (member == null) break;
        members.push(member);
        for (const child of [...(children.get(member.slug) ?? [])].reverse()) {
          pending.push({ slug: child.slug, depth: member.depth + 1,
            ordinal: `${member.ordinal}.${child.ordinal}` });
        }
      }
      if (members.length > 0) descendants.set(root, members);
    }
    return { parent, descendants };
  }
}
