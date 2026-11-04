type Formatters = {
  default: Intl.NumberFormat;
  currency: Intl.NumberFormat;
  percentage: Intl.NumberFormat;
};

let _cache: Option<Formatters> = null;

const lazyFormatters = {
  get(): Formatters {
    if (!_cache) {
      _cache = {
        default: new Intl.NumberFormat("en-US", {
          maximumFractionDigits: 2,
        }),
        currency: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }),
        percentage: new Intl.NumberFormat("en-US", {
          style: "percent",
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }),
      };
    }
    return _cache;
  },
};

export namespace NumberFormatter {
  export const formatters = lazyFormatters;

  export function format(formatter: Intl.NumberFormat, value: number): string {
    return formatter.format(Object.is(value, -0) ? 0 : value);
  }
}
