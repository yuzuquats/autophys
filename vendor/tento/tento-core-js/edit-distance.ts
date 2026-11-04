/**
 * Implementation of the Damerau-Levenshtein distance algorithm for string comparison.
 */
export namespace EditDistance {
  /**
   * Initializes a distance matrix for the Levenshtein algorithm.
   */
  const initMatrix = (s1: string, s2: string): number[][] => {
    const d: number[][] = [];
    for (let i = 0; i <= s1.length; i++) {
      d[i] = [];
      d[i][0] = i;
    }
    for (let j = 0; j <= s2.length; j++) {
      d[0][j] = j;
    }
    return d;
  };

  /**
   * Applies the Damerau extension to handle transpositions in the edit distance calculation.
   */
  const damerau = (
    i: number,
    j: number,
    s1: string,
    s2: string,
    d: number[][],
    cost: number,
  ): void => {
    if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
      d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
    }
  };

  /**
   * Calculates the Damerau-Levenshtein distance between two strings.
   */
  export const distance = (s1: string, s2: string): number => {
    if (typeof s1 != "string" || typeof s2 != "string") {
      return -1;
    }

    const d = initMatrix(s1, s2);
    for (let i = 1; i <= s1.length; i++) {
      for (let j = 1; j <= s2.length; j++) {
        const cost = s1.charAt(i - 1) === s2.charAt(j - 1) ? 0 : 1;

        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + cost,
        );

        damerau(i, j, s1, s2, d, cost);
      }
    }
    return d[s1.length][s2.length];
  };
}
