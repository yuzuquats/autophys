import { Point } from "./point";
import { Regression } from "./regression";

export const memoizedPower = (() => {
  const memo = new Map<string, number>();
  return (a: number, e: number): number => {
    const key = `${a},${e}`;
    const maybeResult = memo.get(key);
    if (maybeResult) return maybeResult;
    const result = a ** e;
    memo.set(key, result);
    return result;
  };
})();

export namespace NumberArray {
  export function average(array: number[]): number {
    return array.reduce((a, b) => a + b) / array.length;
  }
}

export class VelocityPredictor {
  data: Point[] = [];
  normalizedData: Point[] = [];
  normalizedVelocityData: Point[] = [];
  fittedNormalizedVelocityData: Point[] = [];
  predictedData: Point[] = [];

  reset() {
    this.data = [];
    this.normalizedData = [];
    this.normalizedVelocityData = [];
    this.fittedNormalizedVelocityData = [];
    this.predictedData = [];
  }

  pushPoint(point: Point) {
    this.data.push(point);

    const now = Date.now();
    this.normalizedData = this.data.map((p) => ({
      x: p.x - now,
      y: p.y,
    }));

    this.normalizedVelocityData = this.normalizedData
      .slice(1)
      .map((p, i_minus_1) => ({
        x: p.x,
        y: p.y - this.normalizedData[i_minus_1].y,
      }));

    this.predictedData = [];
    const res = Regression.polynomial(
      this.normalizedVelocityData.slice(-100).map((p) => [p.x, p.y]),
      { order: 2, precision: 20 },
    );

    this.fittedNormalizedVelocityData = res.points.map((p) => ({
      x: p[0],
      y: p[1],
    }));

    const getDirection = (n: number): number => {
      if (Math.abs(n) < Number.EPSILON) return 0;
      if (n > 0) return 1;
      if (n < 0) return -1;
      return 0;
    };

    if (this.fittedNormalizedVelocityData.length > 0) {
      const fps = 8.8;
      let lastPosition = this.normalizedData[this.normalizedData.length - 1];
      let last = res.predict(0);

      const lastDirectionSamples = this.normalizedVelocityData
        .slice(-4)
        .map((p) => p.y);
      const lastDirection = getDirection(
        NumberArray.average(lastDirectionSamples),
      );
      const accelerationDirection = getDirection(res.equation[0]);
      const frictionCoefficient =
        lastDirection === accelerationDirection ? 0.9 : 1;

      let currentDirection = lastDirection;
      if (lastDirection === 0) {
        return;
      }

      let cnt = 1;
      while (
        lastDirection != 0 &&
        lastDirection === currentDirection &&
        cnt < 40
      ) {
        const deacceleration = memoizedPower(frictionCoefficient, cnt);
        this.predictedData.push({
          x: last[0],
          y:
            lastPosition.y +
            (deacceleration * last[1] * (last[0] - lastPosition.x)) / 10,
        });

        last = res.predict(cnt * fps);
        currentDirection = getDirection(last[1]);

        this.fittedNormalizedVelocityData.push({
          x: last[0],
          y: deacceleration * last[1],
        });
        lastPosition = this.predictedData[this.predictedData.length - 1];
        cnt += 1;
      }
    }
  }
}
