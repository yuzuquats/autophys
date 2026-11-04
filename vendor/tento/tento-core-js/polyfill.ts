export const replaceAll = (
  s: string,
  toReplace: string,
  toReplaceInto: string,
): string => {
  return s.split(toReplace).join(toReplaceInto);
};

export const matchAll = (s: string, rx: RegExp | string): RegExpExecArray[] => {
  if (typeof rx === "string") rx = new RegExp(rx, "g");
  let cap: Option<RegExpExecArray>;
  const all: RegExpExecArray[] = [];
  let recursionCnt = 0;
  const recursionLimit = 30;
  while ((cap = rx.exec(s)) != null) {
    if (recursionCnt >= recursionLimit) {
      console.warn("recursion limit hit for `matchAll`");
      return all;
    }
    all.push(cap);
    recursionCnt += 1;
  }
  return all;
};
