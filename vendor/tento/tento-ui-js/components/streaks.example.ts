import { GenericRange, Local, NaiveDate, Weekday } from "@tento-chrono";
import { Storybook } from "../ui/storybook";
import { Round } from "./round";
import { Streaks } from "./streaks";

/**
 * Seeded pseudo-random number generator for consistent but varied patterns
 */
class SeededRandom {
	private seed: number;

	constructor(seed: number) {
		this.seed = seed;
	}

	next(): number {
		// Simple LCG (Linear Congruential Generator)
		this.seed = (this.seed * 1664525 + 1013904223) % 2147483647;
		return this.seed / 2147483647;
	}

	nextInt(min: number, max: number): number {
		return Math.floor(this.next() * (max - min + 1)) + min;
	}
}


/**
 * Generate purely random activity data by day
 */
function generateRandomActivity(date: NaiveDate): number {
	const rng = new SeededRandom(date.dse * 12347);
	const chance = rng.next();

	if (chance < 0.4) {
		// 40% chance of no activity
		return 0;
	} else if (chance < 0.65) {
		// 25% chance of low activity
		return 1;
	} else if (chance < 0.85) {
		// 20% chance of medium activity
		return 2;
	} else if (chance < 0.95) {
		// 10% chance of high activity
		return 3;
	} else {
		// 5% chance of max activity
		return 4;
	}
}

/**
 * Generate sparse random data (more empty days)
 */
function generateSparseActivity(date: NaiveDate): number {
	const rng = new SeededRandom(date.dse * 7919);
	const chance = rng.next();

	if (chance < 0.7) {
		// 70% chance of no activity
		return 0;
	} else if (chance < 0.85) {
		// 15% chance of low activity
		return 1;
	} else if (chance < 0.93) {
		// 8% chance of medium activity
		return 2;
	} else if (chance < 0.98) {
		// 5% chance of high activity
		return 3;
	} else {
		// 2% chance of max activity
		return 4;
	}
}

/**
 * Generate dense random data (more active days)
 */
function generateDenseActivity(date: NaiveDate): number {
	const rng = new SeededRandom(date.dse * 3571);
	const chance = rng.next();

	if (chance < 0.15) {
		// 15% chance of no activity
		return 0;
	} else if (chance < 0.35) {
		// 20% chance of low activity
		return 1;
	} else if (chance < 0.6) {
		// 25% chance of medium activity
		return 2;
	} else if (chance < 0.85) {
		// 25% chance of high activity
		return 3;
	} else {
		// 15% chance of max activity
		return 4;
	}
}

export class StreaksStoryBook extends Storybook.Default {
	title(): string {
		return "Streaks";
	}

	examples(): Storybook.Example[] {
		return [
			{
				title: "Random Activity (12 weeks)",
				render: () => {
					const $streaks = Streaks.make();
					$streaks.bind(
						Streaks.Props.makeTodayWithPadding(
							generateRandomActivity,
							12,
							4,
							Weekday.MON,
						),
					);
					return Round.makeWithContent($streaks, Round.Props.FLAT_CARD).assignStyles({
						overflowX: "auto",
						overflowY: "hidden",
						padding: "16px",
						width: "100%",
					});
				},
			},
			{
				title: "Sparse Activity (Year to Date)",
				render: () => {
					const $streaks = Streaks.make();
					$streaks.bind(
						Streaks.Props.makeYearToDate(generateSparseActivity, Weekday.MON),
					);
					return Round.makeWithContent($streaks, Round.Props.FLAT_CARD).assignStyles({
						overflowX: "auto",
						overflowY: "hidden",
						padding: "16px",
						width: "100%",
					});
				},
			},
			{
				title: "Dense Activity (Sunday start)",
				render: () => {
					const $streaks = Streaks.make();
					$streaks.bind(
						Streaks.Props.makeYearToDate(generateDenseActivity, Weekday.SUN),
					);
					return Round.makeWithContent($streaks, Round.Props.FLAT_CARD).assignStyles({
						overflowX: "auto",
						overflowY: "hidden",
						padding: "16px",
						width: "100%",
					});
				},
			},
			{
				title: "Recent Activity (2 week view)",
				render: () => {
					const $streaks = Streaks.make();
					$streaks.bind(
						Streaks.Props.makeTodayWithPadding(
							(date) => {
								// Pure random with different seed
								const rng = new SeededRandom(date.dse * 1237);
								const chance = rng.next();
								if (chance < 0.5) return 0;
								return rng.nextInt(1, 4);
							},
							2,
							1,
							Weekday.MON,
						),
					);
					return Round.makeWithContent($streaks, Round.Props.FLAT_CARD).assignStyles({
						overflowX: "auto",
						overflowY: "hidden",
						padding: "16px",
						width: "100%",
					});
				},
			},
			{
				title: "Custom Range (30 days)",
				render: () => {
					const today = Local.today;
					const start = today.add({ days: -30 }).toStartOfWeekMon();
					const end = today
						.add({ days: 7 })
						.toStartOfWeekMon()
						.add({ days: -1 });

					const $streaks = Streaks.make();
					$streaks.bind({
						range: new GenericRange(start, end),
						today,
						value: (date) => {
							// Different random pattern
							const rng = new SeededRandom(date.dse * 2357);
							return rng.nextInt(0, 4);
						},
					});
					return Round.makeWithContent($streaks, Round.Props.FLAT_CARD).assignStyles({
						overflowX: "auto",
						overflowY: "hidden",
						padding: "16px",
						width: "100%",
					});
				},
			},
			{
				title: "Wednesday Start Alignment",
				render: () => {
					const $streaks = Streaks.make();
					$streaks.bind(
						Streaks.Props.makeTodayWithPadding(
							(date) => {
								// Pure random, not tied to day of week
								const rng = new SeededRandom(date.dse * 9871);
								const val = rng.next();
								if (val < 0.3) return 0;
								if (val < 0.5) return 1;
								if (val < 0.7) return 2;
								if (val < 0.85) return 3;
								return 4;
							},
							4,
							2,
							Weekday.WED,
						),
					);
					return Round.makeWithContent($streaks, Round.Props.FLAT_CARD).assignStyles({
						overflowX: "auto",
						overflowY: "hidden",
						padding: "16px",
						width: "100%",
					});
				},
			},
		];
	}
}
