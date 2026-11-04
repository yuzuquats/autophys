import { Duration, Ms } from "@tento-chrono";
import { LiveData } from "@tento-core/livedata";

export interface TimeBlock {
  id: string;
  dayIndex: number;
  startTime: Duration.Time;
  endTime: Duration.Time;
  title?: string;
  color?: string;
}

export interface WeeklyScheduleState {
  timeBlocks: TimeBlock[];
  ghostBlock?: Option<{
    startDayIndex: number;
    startTime: Duration.Time;
    endDayIndex: number;
    endTime: Duration.Time;
  }>;
  activeBlockId?: Option<string>;
}

export class WeeklyScheduleController {
  private _state: LiveData<WeeklyScheduleState>;
  private nextId = 1;

  constructor() {
    this._state = LiveData.new<WeeklyScheduleState>({
      timeBlocks: [],
    });
  }

  get state(): LiveData.Readable<WeeklyScheduleState> {
    return this._state;
  }

  // Create a new time block
  createTimeBlock(
    dayIndex: number,
    startTime: Duration.Time,
    endTime: Duration.Time,
  ): string {
    // Round times to nearest 15 minutes
    const roundedStartTime = startTime.floor(Duration.Time.MIN15);
    const roundedEndTime = endTime.floor(Duration.Time.MIN15);

    // Check for overlapping blocks and merge if necessary
    const mergedBlock = this.mergeOverlappingBlocks(
      dayIndex,
      roundedStartTime,
      roundedEndTime,
    );

    if (mergedBlock) {
      // Select the merged block
      const currentState = this._state.get();
      this._state.update({
        ...currentState,
      });
      return mergedBlock.id;
    }

    // No overlap, create new block
    const id = `block-${this.nextId++}`;
    const newBlock: TimeBlock = {
      id,
      dayIndex,
      startTime: roundedStartTime,
      endTime: roundedEndTime,
      title: "New Event",
    };

    const currentState = this._state.get();
    this._state.update({
      ...currentState,
      timeBlocks: [...currentState.timeBlocks, newBlock],
    });

    return id;
  }

  // Show ghost block during drag
  showGhostBlock(
    startDayIndex: number,
    startTime: Duration.Time,
    endDayIndex: number,
    endTime: Duration.Time,
  ) {
    // Round times to nearest 15 minutes
    const roundedStartTime = startTime.floor(Duration.Time.MIN15);
    const roundedEndTime = endTime.floor(Duration.Time.MIN15);

    const currentState = this._state.get();
    this._state.update({
      ...currentState,
      ghostBlock: {
        startDayIndex,
        startTime: roundedStartTime,
        endDayIndex,
        endTime: roundedEndTime,
      },
    });
  }

  // Hide ghost block
  hideGhostBlock() {
    const currentState = this._state.get();
    this._state.update({
      ...currentState,
      ghostBlock: undefined,
    });
  }

  // Update an existing time block
  updateTimeBlock(
    id: string,
    updates: Partial<TimeBlock>,
    isActive: Option<"active" | "inactive"> = null,
  ) {
    const currentState = this._state.get();

    if (updates.startTime) {
      updates.startTime = updates.startTime.floor(Duration.Time.MIN15);
    }
    if (updates.endTime) {
      updates.endTime = updates.endTime.floor(Duration.Time.MIN15);
    }

    const newBlocks = currentState.timeBlocks.map((block) =>
      block.id === id ? { ...block, ...updates } : block,
    );

    const newState = {
      ...currentState,
      timeBlocks: newBlocks,
      activeBlockId: isActive ? id : currentState.activeBlockId,
    };

    this._state.update(newState);
  }

  // Move a time block to a new time/day
  moveTimeBlock(id: string, dayIndex: number, startTime: Duration.Time) {
    const state = this._state.get();
    const block = state.timeBlocks.find((b) => b.id === id);
    if (!block) {
      return;
    }

    // Round start time to nearest 15 minutes
    const roundedStartTime = startTime.floor(Duration.Time.MIN15);
    const durationMs = block.endTime.toMs - block.startTime.toMs;
    const totalMs = roundedStartTime.toMs + durationMs;
    const endTime = Duration.Time.from({ ms: totalMs as Ms });

    // Check for overlaps and merge if necessary
    const overlappingBlocks = this.findOverlappingBlocks(
      dayIndex,
      roundedStartTime,
      endTime,
      id, // Exclude the block being moved
    );

    // Always remove the original block being moved
    const blocksToRemove = new Set([id]);

    if (overlappingBlocks.length > 0) {
      // Merge with overlapping blocks
      let mergedStart = roundedStartTime.toMs;
      let mergedEnd = endTime.toMs;

      for (const overlapBlock of overlappingBlocks) {
        mergedStart = Math.min(mergedStart, overlapBlock.startTime.toMs) as Ms;
        mergedEnd = Math.max(mergedEnd, overlapBlock.endTime.toMs) as Ms;
        blocksToRemove.add(overlapBlock.id);
      }

      // Remove the moved block and all overlapping blocks
      const remainingBlocks = state.timeBlocks.filter(
        (b) => !blocksToRemove.has(b.id),
      );

      // Create a new merged block
      const mergedBlock: TimeBlock = {
        id: `block-${this.nextId++}`, // New ID for merged block
        dayIndex,
        startTime: Duration.Time.from({ ms: mergedStart as Ms }),
        endTime: Duration.Time.from({ ms: mergedEnd as Ms }),
        title: block.title,
        color: block.color,
      };

      this._state.update({
        ...state,
        timeBlocks: [...remainingBlocks, mergedBlock],
      });
    } else {
      // No overlap, create a new block at the new position and remove the old one
      const remainingBlocks = state.timeBlocks.filter((b) => b.id !== id);

      const movedBlock: TimeBlock = {
        id: `block-${this.nextId++}`, // New ID for moved block
        dayIndex,
        startTime: roundedStartTime,
        endTime,
        title: block.title,
        color: block.color,
      };

      this._state.update({
        ...state,
        timeBlocks: [...remainingBlocks, movedBlock],
      });
    }
  }

  // Resize a time block
  resizeTimeBlock(
    id: string,
    newStartTime: Duration.Time,
    newEndTime: Duration.Time,
  ) {
    const state = this._state.get();
    const block = state.timeBlocks.find((b) => b.id === id);
    if (!block) return;

    // Round times to nearest 15 minutes
    const roundedStartTime = newStartTime.floor(Duration.Time.MIN15);
    const roundedEndTime = newEndTime.floor(Duration.Time.MIN15);

    // Check for overlaps and merge if necessary
    const overlappingBlocks = this.findOverlappingBlocks(
      block.dayIndex,
      roundedStartTime,
      roundedEndTime,
      id, // Exclude the block being resized
    );

    if (overlappingBlocks.length > 0) {
      // Merge with overlapping blocks
      let mergedStart = roundedStartTime.toMs;
      let mergedEnd = roundedEndTime.toMs;

      for (const overlapBlock of overlappingBlocks) {
        mergedStart = Math.min(mergedStart, overlapBlock.startTime.toMs) as Ms;
        mergedEnd = Math.max(mergedEnd, overlapBlock.endTime.toMs) as Ms;
      }

      // Remove the resized block and all overlapping blocks
      const blocksToRemove = new Set([
        id,
        ...overlappingBlocks.map((b) => b.id),
      ]);
      const remainingBlocks = state.timeBlocks.filter(
        (b) => !blocksToRemove.has(b.id),
      );

      // Create a new merged block (don't reuse the old one)
      const mergedBlock: TimeBlock = {
        id: `block-${this.nextId++}`, // New ID for merged block
        dayIndex: block.dayIndex,
        startTime: Duration.Time.from({ ms: mergedStart as Ms }),
        endTime: Duration.Time.from({ ms: mergedEnd as Ms }),
        title: block.title,
        color: block.color,
      };

      this._state.update({
        ...state,
        timeBlocks: [...remainingBlocks, mergedBlock],
      });
    } else {
      // No overlap, just resize the block
      this.updateTimeBlock(
        id,
        {
          startTime: roundedStartTime,
          endTime: roundedEndTime,
        },
        "inactive",
      );
    }
  }

  // Delete a time block
  deleteTimeBlock(id: string) {
    const currentState = this._state.get();
    this._state.update({
      ...currentState,
      timeBlocks: currentState.timeBlocks.filter((block) => block.id !== id),
    });
  }

  // Select a time block
  selectTimeBlock(id: string) {
    const currentState = this._state.get();
    this._state.update({
      ...currentState,
    });
  }

  // Clear selection
  clearSelection() {
    const currentState = this._state.get();
    this._state.update({
      ...currentState,
    });
  }

  // Get all time blocks for a specific day
  getTimeBlocksForDay(dayIndex: number): TimeBlock[] {
    return this._state
      .get()
      .timeBlocks.filter((block) => block.dayIndex === dayIndex);
  }

  // Get all time blocks
  getAllTimeBlocks(): TimeBlock[] {
    return this._state.get().timeBlocks;
  }

  // Find overlapping blocks
  private findOverlappingBlocks(
    dayIndex: number,
    startTime: Duration.Time,
    endTime: Duration.Time,
    excludeBlockId?: string,
  ): TimeBlock[] {
    const currentState = this._state.get();
    const overlappingBlocks: TimeBlock[] = [];

    for (const block of currentState.timeBlocks) {
      if (block.dayIndex !== dayIndex || block.id === excludeBlockId) {
        continue;
      }

      const blockStart = block.startTime.toMs;
      const blockEnd = block.endTime.toMs;
      const newStart = startTime.toMs;
      const newEnd = endTime.toMs;

      // Check for overlap or adjacency (blocks that touch)
      if (!(newEnd < blockStart || newStart > blockEnd)) {
        overlappingBlocks.push(block);
      }
    }

    return overlappingBlocks;
  }

  // Merge overlapping blocks
  private mergeOverlappingBlocks(
    dayIndex: number,
    startTime: Duration.Time,
    endTime: Duration.Time,
  ): TimeBlock | null {
    const currentState = this._state.get();
    const dayBlocks = this.getTimeBlocksForDay(dayIndex);

    // Find all overlapping blocks
    const overlappingBlocks: TimeBlock[] = [];
    const nonOverlappingBlocks: TimeBlock[] = [];

    for (const block of currentState.timeBlocks) {
      if (block.dayIndex !== dayIndex) {
        nonOverlappingBlocks.push(block);
        continue;
      }

      const blockStart = block.startTime.toMs;
      const blockEnd = block.endTime.toMs;
      const newStart = startTime.toMs;
      const newEnd = endTime.toMs;

      // Check for overlap or adjacency (blocks that touch)
      if (!(newEnd < blockStart || newStart > blockEnd)) {
        overlappingBlocks.push(block);
      } else {
        nonOverlappingBlocks.push(block);
      }
    }

    if (overlappingBlocks.length === 0) {
      return null; // No overlaps
    }

    // Calculate the merged time range
    let mergedStart = startTime.toMs;
    let mergedEnd = endTime.toMs;

    for (const block of overlappingBlocks) {
      mergedStart = Math.min(mergedStart, block.startTime.toMs) as Ms;
      mergedEnd = Math.max(mergedEnd, block.endTime.toMs) as Ms;
    }

    // Create a new merged block (don't reuse any existing block)
    const mergedBlock: TimeBlock = {
      id: `block-${this.nextId++}`, // New ID for merged block
      dayIndex,
      startTime: Duration.Time.from({ ms: mergedStart as Ms }),
      endTime: Duration.Time.from({ ms: mergedEnd as Ms }),
      title: overlappingBlocks[0].title || "New Event",
      color: overlappingBlocks[0].color,
    };

    // Update state with merged block
    this._state.update({
      ...currentState,
      timeBlocks: [...nonOverlappingBlocks, mergedBlock],
    });

    return mergedBlock;
  }

  // Check if a time slot is available
  isTimeSlotAvailable(
    dayIndex: number,
    startTime: Duration.Time,
    endTime: Duration.Time,
    excludeBlockId?: string,
  ): boolean {
    const dayBlocks = this.getTimeBlocksForDay(dayIndex);

    for (const block of dayBlocks) {
      if (block.id === excludeBlockId) continue;

      // Check for overlap
      const blockStart = block.startTime.toMs;
      const blockEnd = block.endTime.toMs;
      const newStart = startTime.toMs;
      const newEnd = endTime.toMs;

      if (!(newEnd <= blockStart || newStart >= blockEnd)) {
        return false; // Overlap detected
      }
    }

    return true;
  }

  // Set active state for a block (during any gesture)
  setBlockActive(id: string, isActive: boolean) {
    const state = this.state.get();
    if (state.activeBlockId === id) return;
    const currentState = this._state.get();
    this._state.update({
      ...currentState,
      activeBlockId: isActive ? id : null,
    });
  }

  clearActiveBlock() {
    const state = this.state.get();
    this._state.update({
      ...state,
      activeBlockId: null,
    });
  }

  get activeBlockId(): Option<string> {
    return this._state.get()?.activeBlockId;
  }

  // Clear all time blocks
  clearAll() {
    this._state.update({
      timeBlocks: [],
      ghostBlock: null,
      activeBlockId: null,
    });
  }

  // Load time blocks from external source
  loadTimeBlocks(blocks: Omit<TimeBlock, "id">[]) {
    const timeBlocks = blocks.map((block) => ({
      ...block,
      id: `block-${this.nextId++}`,
    }));

    this._state.update({
      timeBlocks,
      ghostBlock: null,
      activeBlockId: null,
    });
  }
}
