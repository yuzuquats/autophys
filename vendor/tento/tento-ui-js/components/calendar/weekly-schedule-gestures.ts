import { DateFragment, Duration, Ms, Time } from "@tento-chrono";
import { Tracing } from "@tento-core/tracing";
import { CalendarColumnCell } from "./calendar-column-cell";
import { CalendarGesture } from "./calendar-gesture";
import {
	TimeBlock,
	WeeklyScheduleController,
} from "./weekly-schedule-controller";

export namespace WeeklyScheduleGestures {
	export interface DayInfo extends CalendarGesture.WindowedInfo {
		dayIndex: number;
		toString: () => string;
		timeBlock?: TimeBlock;
		windowed: DateFragment.Windowed;
	}

	export interface TimeRange {
		start: Duration.Time;
		end: Duration.Time;
	}

	export type TimeBlockCallback = (
		dayIndex: number,
		timeRange: TimeRange,
	) => void;
	export type TimeBlockDraggedCallback = (
		dayIndex: number,
		startTime: Duration.Time,
		endTime: Duration.Time,
	) => void;
	export type TimeBlockResizedCallback = (
		blockId: string,
		newTimeRange: TimeRange,
	) => void;
	export type TimeBlockMovedCallback = (
		blockId: string,
		newDayIndex: number,
		newTimeRange: TimeRange,
	) => void;
	export type TimeBlockContextMenuCallback = (
		blockId: string,
		offset: { x: number; y: number },
	) => void;

	export class ClickToCreateGesture extends CalendarGesture.Default<DayInfo> {
		readonly identifier = "weekly-schedule-click-to-create";

		constructor(private controller: WeeklyScheduleController) {
			super();
		}

		canHandle(event: CalendarGesture.Event<DayInfo>): boolean {
			return event.internal.pointerUpColumn != null;
		}

		allowsConcurrentGestures(): boolean {
			return false;
		}

		onPointerUpColumn({
			info,
			position,
		}: CalendarGesture.Event.PointerUpColumn<DayInfo>): {
			finished: boolean;
		} {
			const startTime = position.round(Duration.Time.MIN15);
			const endTime = startTime.add(Duration.Time.hrs(1));

			this.controller.createTimeBlock(info.dayIndex, startTime, endTime);

			return {
				finished: true,
			};
		}
	}

	export class DragToCreateGesture extends CalendarGesture.Default<DayInfo> {
		readonly identifier = "weekly-schedule-drag-to-create";

		private state: Option<{
			holdingWeakly: boolean;
			startPosition: Duration.Time;
			startDayIndex: number;
		}> = null;

		constructor(private controller: WeeklyScheduleController) {
			super();
		}

		canHandle(event: CalendarGesture.Event<DayInfo>): boolean {
			const pointerDown = event.internal.pointerDown;
			if (!pointerDown) return false;
			if (pointerDown.handle != null) return false;
			if (pointerDown.onEvent) return false;
			return true;
		}

		allowsConcurrentGestures(): boolean {
			return this.state?.holdingWeakly ?? true;
		}

		onPointerDown(e: CalendarGesture.Event.PointerDown<DayInfo>): {
			finished: boolean;
		} {
			this.state = {
				holdingWeakly: true,
				startPosition: e.position,
				startDayIndex: e.info.dayIndex,
			};
			return { finished: false };
		}

		onPointerMove(e: CalendarGesture.Event.PointerMove<DayInfo>): {
			shouldCapturePointer: boolean;
		} {
			if (!this.state) return { shouldCapturePointer: false };

			this.state.holdingWeakly =
				this.state.holdingWeakly &&
				Math.abs(e.delta.toMins) < 15 &&
				e.info.dayIndex === this.state.startDayIndex;

			if (this.state.holdingWeakly) {
				return { shouldCapturePointer: false };
			}

			let startTime = this.state.startPosition.round(Duration.Time.MIN15);
			let endTime = e.position.round(Duration.Time.MIN15);

			if (endTime.toMs < startTime.toMs) {
				[startTime, endTime] = [endTime, startTime];
			}

			if (endTime.toMs === startTime.toMs) {
				endTime = startTime.add(Duration.Time.MIN15);
			}

			this.controller.showGhostBlock(
				e.info.dayIndex,
				startTime,
				e.info.dayIndex,
				endTime,
			);

			const fifteenMinAfterStartWindow = endTime.toMs <= 0;
			const fifteenMinBeforeEndWindow =
				endTime.toMs >= 23.75 * Time.MS_PER_HR;
			const shouldCapturePointer =
				fifteenMinAfterStartWindow || fifteenMinBeforeEndWindow;

			return { shouldCapturePointer };
		}

		onPointerUpColumn(e: CalendarGesture.Event.PointerUpColumn<DayInfo>): {
			finished: boolean;
		} {
			if (!this.state || this.state.holdingWeakly) {
				return { finished: true };
			}

			let startTime = this.state.startPosition.round(Duration.Time.MIN15);
			let endTime = e.position.round(Duration.Time.MIN15);

			if (endTime.toMs < startTime.toMs) {
				[startTime, endTime] = [endTime, startTime];
			}

			if (endTime.toMs === startTime.toMs) {
				endTime = startTime.add(Duration.Time.MIN15);
			}

			this.controller.createTimeBlock(e.info.dayIndex, startTime, endTime);
			this.controller.hideGhostBlock();
			this.state = null;

			return { finished: true };
		}

		onPointerUpCell(e: CalendarGesture.Event.PointerUpCell<DayInfo>): {
			finished: boolean;
		} {
			return this.onPointerUpColumn({
				info: e.info,
				position: e.position,
			} as CalendarGesture.Event.PointerUpColumn<DayInfo>);
		}

		onFinished(): void {
			this.state = null;
		}
	}

	export class MoveGesture extends CalendarGesture.Default<DayInfo> {
		readonly identifier = "weekly-schedule-move";

		private state: Option<{
			blockId: string;
			block: TimeBlock;
			holdingWeakly: boolean;
			initialDayIndex: number;
			correction: Duration.Time;
		}> = null;

		constructor(private controller: WeeklyScheduleController) {
			super();
		}

		canHandle(event: CalendarGesture.Event<DayInfo>): boolean {
			const pointerDown = event.internal.pointerDown;
			if (!pointerDown) return false;
			if (pointerDown.handle != null) return false;
			if (!pointerDown.info.timeBlock) return false;
			if (!pointerDown.onEvent) return false;
			return true;
		}

		allowsConcurrentGestures(): boolean {
			return this.state?.holdingWeakly ?? true;
		}

		onPointerDown(e: CalendarGesture.Event.PointerDown<DayInfo>): {
			finished: boolean;
		} {
			const block = e.info.timeBlock;
			if (!block) return { finished: true };

			this.state = {
				blockId: block.id,
				block,
				holdingWeakly: true,
				initialDayIndex: e.info.dayIndex,
				correction: e.position,
			};

			return { finished: false };
		}

		onPointerMove(e: CalendarGesture.Event.PointerMove<DayInfo>): {
			shouldCapturePointer: boolean;
		} {
			if (!this.state) return { shouldCapturePointer: false };

			const wasHoldingWeakly = this.state.holdingWeakly;
			this.state.holdingWeakly =
				this.state.holdingWeakly &&
				Math.abs(e.delta.toMins) < 15 &&
				e.info.dayIndex === this.state.initialDayIndex;

			if (this.state.holdingWeakly) {
				return { shouldCapturePointer: false };
			}

			this.controller.setBlockActive(this.state.blockId, true);
			if (wasHoldingWeakly && !this.state.holdingWeakly) {
				this.controller.showGhostBlock(
					this.state.initialDayIndex,
					this.state.block.startTime,
					this.state.initialDayIndex,
					this.state.block.endTime,
				);
			}

			const delta = e.position.sub(this.state.correction);

			const newStartMs = this.state.block.startTime.toMs + delta.toMs;
			const newStartTime = Duration.Time.from({ ms: newStartMs as Ms }).round(
				Duration.Time.MIN15,
			);

			const durationMs =
				this.state.block.endTime.toMs - this.state.block.startTime.toMs;
			const newEndMs = newStartTime.toMs + durationMs;
			const newEndTime = Duration.Time.from({ ms: newEndMs as Ms });

			this.controller.showGhostBlock(
				e.info.dayIndex,
				newStartTime,
				e.info.dayIndex,
				newEndTime,
			);

			return { shouldCapturePointer: false };
		}

		onPointerUpColumn(e: CalendarGesture.Event.PointerUpColumn<DayInfo>): {
			finished: boolean;
		} {
			if (!this.state || this.state.holdingWeakly) {
				return { finished: true };
			}

			const delta = e.position.sub(this.state.correction);

			const newStartMs = this.state.block.startTime.toMs + delta.toMs;
			const newStartTime = Duration.Time.from({ ms: newStartMs as Ms }).round(
				Duration.Time.MIN15,
			);

			this.controller.hideGhostBlock();
			this.controller.moveTimeBlock(
				this.state.blockId,
				e.info.dayIndex,
				newStartTime,
			);

			return { finished: true };
		}

		onPointerUpCell(e: CalendarGesture.Event.PointerUpCell<DayInfo>): {
			finished: boolean;
		} {
			return this.onPointerUpColumn({
				info: e.info,
				position: e.position,
			} as CalendarGesture.Event.PointerUpColumn<DayInfo>);
		}

		onFinished(): void {
			if (!this.state) return;

			// If gesture was cancelled, reset the active state
			// (If it completed normally, moveTimeBlock already reset it)
			const blocks = this.controller.getAllTimeBlocks();
			const block = blocks.find((b) => b.id === this.state?.blockId);
			if (this.controller.activeBlockId === this.state.blockId) {
				this.controller.setBlockActive(this.state.blockId, false);
			}
			this.controller.hideGhostBlock();
		}
	}

	export class ResizeGesture extends CalendarGesture.Default<DayInfo> {
		readonly identifier = "weekly-schedule-resize";

		private state: Option<{
			blockId: string;
			block: TimeBlock;
			handle: "top" | "bottom";
			anchor: Duration.Time;
			correction: Duration.Time;
		}> = null;

		constructor(private controller: WeeklyScheduleController) {
			super();
		}

		canHandle(event: CalendarGesture.Event<DayInfo>): boolean {
			const pointerDown = event.internal.pointerDown;
			if (!pointerDown) return false;
			if (pointerDown.handle == null) return false;
			if (!pointerDown.info.timeBlock) return false;
			return true;
		}

		allowsConcurrentGestures(): boolean {
			return false;
		}

		onPointerDown(e: CalendarGesture.Event.PointerDown<DayInfo>): {
			finished: boolean;
		} {
			const block = e.info.timeBlock;
			if (!block || !e.handle) return { finished: true };

			let correction: Duration.Time;
			let anchor: Duration.Time;

			if (e.handle === "top") {
				const startMs = block.startTime.toMs - e.position.toMs;
				correction = Duration.Time.from({ ms: startMs as Ms });
				anchor = block.endTime;
			} else {
				const endMs = block.endTime.toMs - e.position.toMs;
				correction = Duration.Time.from({ ms: endMs as Ms });
				anchor = block.startTime;
			}

			this.state = {
				blockId: block.id,
				block,
				handle: e.handle,
				anchor,
				correction,
			};

			document.body.style.cursor = "ns-resize";

			return { finished: false };
		}

		onPointerMove(e: CalendarGesture.Event.PointerMove<DayInfo>): {
			shouldCapturePointer: boolean;
		} {
			if (!this.state) return { shouldCapturePointer: false };

			const newTimeMs = e.position.toMs + this.state.correction.toMs;
			const newTime = Duration.Time.from({ ms: newTimeMs as Ms }).round(
				Duration.Time.MIN15,
			);

			let startTime: Duration.Time;
			let endTime: Duration.Time;

			if (this.state.handle === "top") {
				startTime = newTime;
				endTime = this.state.anchor;
			} else {
				startTime = this.state.anchor;
				endTime = newTime;
			}

			if (endTime.toMs <= startTime.toMs) {
				if (this.state.handle === "top") {
					startTime = this.state.anchor.sub(Duration.Time.MIN15);
				} else {
					endTime = this.state.anchor.add(Duration.Time.MIN15);
				}
			}

			this.controller.setBlockActive(this.state.blockId, true);
			this.controller.showGhostBlock(
				e.info.dayIndex,
				startTime,
				e.info.dayIndex,
				endTime,
			);

			return { shouldCapturePointer: false };
		}

		onPointerUpColumn(e: CalendarGesture.Event.PointerUpColumn<DayInfo>): {
			finished: boolean;
		} {
			if (!this.state) return { finished: true };

			const newTimeMs = e.position.toMs + this.state.correction.toMs;
			const newTime = Duration.Time.from({ ms: newTimeMs as Ms }).round(
				Duration.Time.MIN15,
			);

			let startTime: Duration.Time;
			let endTime: Duration.Time;

			if (this.state.handle === "top") {
				startTime = newTime;
				endTime = this.state.anchor;
			} else {
				startTime = this.state.anchor;
				endTime = newTime;
			}

			if (endTime.toMs <= startTime.toMs) {
				if (this.state.handle === "top") {
					startTime = this.state.anchor.sub(Duration.Time.MIN15);
				} else {
					endTime = this.state.anchor.add(Duration.Time.MIN15);
				}
			}

			this.controller.hideGhostBlock();
			this.controller.resizeTimeBlock(this.state.blockId, startTime, endTime);

			return { finished: true };
		}

		onPointerUpCell(e: CalendarGesture.Event.PointerUpCell<DayInfo>): {
			finished: boolean;
		} {
			return this.onPointerUpColumn({
				info: e.info,
				position: e.position,
			} as CalendarGesture.Event.PointerUpColumn<DayInfo>);
		}

		onFinished(): void {
			if (this.state) this.controller.hideGhostBlock();
			this.controller.clearActiveBlock();
			document.body.style.cursor = "";
			this.state = null;
		}
	}

	export class ContextMenuGesture extends CalendarGesture.Default<DayInfo> {
		readonly identifier = "weekly-schedule-context-menu";

		private weak = false;
		private onContextMenu?: TimeBlockContextMenuCallback;

		constructor(
			private controller: WeeklyScheduleController,
			onContextMenu?: TimeBlockContextMenuCallback,
		) {
			super();
			this.onContextMenu = onContextMenu;
		}

		canHandle(event: CalendarGesture.Event<DayInfo>): boolean {
			const handled =
				event.matchOpt({
					pointerDownContextMenu: (ev) => ev.info.timeBlock != null,
				}) ?? false;
			return handled;
		}

		allowsConcurrentGestures(): boolean {
			return this.weak;
		}

		onPointerDownContextMenu({
			info,
			offset,
		}: CalendarGesture.Event.PointerDownContextMenu<DayInfo>): {
			finished: boolean;
		} {
			if (!info.timeBlock) {
				return { finished: true };
			}

			this.weak = true;

			if (this.onContextMenu) {
				this.onContextMenu(info.timeBlock.id, offset);
			} else {
				const deleteOption = confirm("Delete this time block?");
				if (deleteOption) {
					this.controller.deleteTimeBlock(info.timeBlock.id);
				}
			}

			return { finished: false };
		}

		onPointerUpCell(): {
			finished: boolean;
		} {
			return { finished: true };
		}

		onPointerUpColumn(): {
			finished: boolean;
		} {
			return { finished: true };
		}

		onFinished(): void {
			this.weak = false;
		}
	}
}
