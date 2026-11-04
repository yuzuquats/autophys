# TwoWaySlider Component Design Document

## Overview

The TwoWaySlider component extends the concept of a traditional slider to allow users to select a range of values by dragging from either end. Additionally, users can drag the middle section to shift the entire selected range.

## Component Requirements

### Functional Requirements
1. **Two-way dragging**: Users can drag either the left or right handle to adjust the range boundaries
2. **Middle drag**: Dragging the middle section shifts the entire range while maintaining its width
3. **Parameterization**:
   - `min`: Minimum allowed value
   - `max`: Maximum allowed value  
   - `min-width`: Minimum width of the selected range
4. **Reuse existing slider styles and code where possible**

### Visual Requirements
- Should maintain visual consistency with existing slider components
- Clear visual distinction between:
  - Left handle
  - Right handle
  - Selected range (middle draggable area)
  - Unselected track areas

## Technical Analysis

### Existing Slider Architecture

The current slider implementation provides:

1. **State Management** (Slider.State class):
   - Manages range, value, width, and snap points
   - Provides methods for value/pixel conversions
   - Immutable state updates via `with*` methods

2. **Gesture Handling**:
   - Uses GESTURE_MANAGER for drag operations
   - Handles pointer events with proper propagation control

3. **Styling Approach**:
   - CSS custom properties for theming
   - Modular style blocks that can be extracted

4. **Layout Calculations**:
   - `layoutValue()`: Converts values to pixel positions
   - `withProgressPx()`: Updates state based on pixel position

### Reusable Components

#### Extractable Styles
```typescript
// Common track styles
export const trackStyles = css`
  --std-slider-track-color: var(--hover-color, rgba(0, 0, 0, 0.03));
  --std-slider-thumb-color: var(--background-color, white);
  --std-slider-thumb-border-color: var(--divider, rgba(0, 0, 0, 0.12));
`;

// Common thumb styles  
export const thumbStyles = css`
  .thumb {
    position: absolute;
    height: 18px;
    width: 18px;
    border-radius: 10px;
    background: var(--std-slider-thumb-color);
    border: 1px solid var(--std-slider-thumb-border-color);
    cursor: pointer;
    z-index: 999;
  }
`;
```

#### Reusable State Logic
- Extend or compose the existing `Slider.State` class
- Reuse pixel/value conversion methods
- Adapt snap functionality for range constraints

## Proposed Architecture

### State Management

```typescript
export class TwoWaySliderState {
  readonly min: number;
  readonly max: number;
  readonly minWidth: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly widthPx: number;
  readonly trackPaddingPx: number;
  
  // Constraint validation
  isValidRange(start: number, end: number): boolean {
    return (
      start >= this.min &&
      end <= this.max &&
      end - start >= this.minWidth
    );
  }
  
  // Handle updates
  withRangeStart(value: number): TwoWaySliderState
  withRangeEnd(value: number): TwoWaySliderState
  withRangeShift(deltaPx: number): TwoWaySliderState
  
  // Layout calculations
  layoutRange(): { startPx: number; endPx: number; widthPx: number }
  pixelToValue(px: number): number
  valueToPixel(value: number): number
}
```

### Component Structure

```typescript
@component({
  name: "std-two-way-slider",
})
export class TwoWaySlider extends LonaWebComponent {
  private state: TwoWaySliderState;
  
  // Callbacks
  onRangeChanged: (start: number, end: number) => void;
  
  // Three drag handlers
  private setupLeftHandleDrag()
  private setupRightHandleDrag()
  private setupMiddleDrag()
  
  // Rendering
  private render(state: TwoWaySliderState)
}
```

### HTML Structure

```html
<div id="track">
  <div id="unselected-left"></div>
  <div id="selected-range">
    <div id="left-handle" class="thumb"></div>
    <div id="right-handle" class="thumb"></div>
  </div>
  <div id="unselected-right"></div>
</div>
<div id="label-row">
  <div id="min-label"></div>
  <div id="max-label"></div>
  <div id="range-label"></div>
</div>
```

### Gesture Handling Strategy

1. **Left Handle**: 
   - Constrained by `min` value and `rangeEnd - minWidth`
   - Updates `rangeStart` only

2. **Right Handle**:
   - Constrained by `rangeStart + minWidth` and `max` value
   - Updates `rangeEnd` only

3. **Middle Section**:
   - Maintains current range width
   - Shifts both `rangeStart` and `rangeEnd` together
   - Constrained by `min` and `max` boundaries

### Styling Approach

1. Extract common styles into static constants
2. Use CSS custom properties for theming consistency
3. Specific styles for:
   - Selected range highlight
   - Handle differentiation (optional visual distinction)
   - Hover/active states for middle section

## Implementation Plan

1. **Phase 1: Core Component**
   - Create `TwoWaySliderState` class with constraint logic
   - Implement basic component structure
   - Set up three gesture handlers

2. **Phase 2: Style Extraction**
   - Extract reusable styles from existing sliders
   - Create component-specific styles
   - Ensure visual consistency

3. **Phase 3: Features**
   - Add snap point support for range boundaries
   - Implement keyboard navigation
   - Add accessibility attributes

4. **Phase 4: Testing & Examples**
   - Create example/storybook file
   - Test edge cases (min-width constraints, boundary conditions)
   - Add to UI routes

## Alternative Considerations

1. **Single State vs Dual State**: Using a single state object for the range vs separate start/end values
   - Decision: Single state for consistency with existing patterns

2. **Visual Handle Differentiation**: Whether handles should look identical or have visual distinction
   - Decision: Keep identical for simplicity, can be customized via CSS

3. **Middle Drag Behavior**: Click-to-position vs drag-only
   - Decision: Drag-only to prevent accidental range shifts

## API Example

```typescript
const slider = TwoWaySlider.make();
slider.bind({
  min: 0,
  max: 100,
  minWidth: 10,
  rangeStart: 20,
  rangeEnd: 60,
  onRangeChanged: (start, end) => {
    console.log(`Range: ${start} - ${end}`);
  }
});
```