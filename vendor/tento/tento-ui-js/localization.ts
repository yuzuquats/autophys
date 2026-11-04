export namespace Localization {
  export function pluralize(s: string, n: number = 2): string {
    if (n > 1) return s + "s";
    return s;
  }

  export function capitalize(word: string) {
    if (!word) return "";
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
}
