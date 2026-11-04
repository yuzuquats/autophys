function memoize<A, R>(fn: (a: A) => R): (a: A) => R {
  const cache: Map<A, R> = new Map();
  return (arg: A) => {
    const cached = cache.get(arg);
    if (cached !== undefined) return cached;
    const result = fn(arg);
    cache.set(arg, result);
    return result;
  };
}

export namespace NumberFormat {
  function _getSeparator(locale: Option<string>): {
    thousand: string;
    decimal: string;
  } {
    return {
      thousand: Intl.NumberFormat(locale ?? undefined).formatToParts(11111)[1]
        .value,
      decimal: Intl.NumberFormat(locale ?? undefined).formatToParts(1.1)[1]
        .value,
    };
  }

  export const getSeparator = memoize(_getSeparator);

  export function parse(
    num: string,
    locale: Option<string> = "en-US",
  ): Option<number> {
    const { thousand, decimal } = getSeparator(locale);

    const n = parseFloat(
      num
        .replace(new RegExp("\\" + thousand, "g"), "")
        .replace(new RegExp("\\" + decimal), ".")
        .replace(/[^0-9.-]/g, ""),
    );
    return isNaN(n) ? null : n;
  }
}
