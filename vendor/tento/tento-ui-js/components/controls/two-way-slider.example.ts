import { Column, Div, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { TwoWaySlider } from "./two-way-slider";

export class TwoWaySliderStoryBook extends Storybook.Default {
  title(): string {
    return "Two-Way Slider";
  }

  tags(): string[] {
    return ["std-two-way-slider"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default Two-Way Slider",
        render: () => {
          return Storybook.fill(TwoWaySlider.Default.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 20,
            rangeEnd: 60,
            showTooltip: true,
            onRangeChanged: (start, end) => {},
          }), "320px");
        },
      },
      {
        title: "Thick Two-Way Slider",
        render: () => {
          const $container = Div.make();
          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 30,
            rangeEnd: 70,
            showTooltip: true,
          });

          const $label = Typography.text("Volume Range");
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          $container.appendChild($slider);
          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Custom Range with Min Width",
        render: () => {
          const $container = Div.make();

          const $info = Div.make();
          $info.style.marginTop = "16px";
          $info.innerHTML = `
            <p style="color: var(--text-sec)">Min: 0, Max: 500, Min Width: 50</p>
            <p style="margin-top: 4px">Current Range: <strong>100 - 300</strong></p>
          `;

          const $slider = TwoWaySlider.Default.makeWith({
            min: 0,
            max: 500,
            minWidth: 50,
            rangeStart: 100,
            rangeEnd: 300,
            showTooltip: true,
            onRangeChanged: (start, end) => {
              $info.querySelector("strong")!.textContent =
                `${Math.round(start)} - ${Math.round(end)}`;
            },
          });

          $container.appendChild($slider);
          $container.appendChild($info);
          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Small Range Example",
        render: () => {
          const $container = Div.make();
          const $output = Typography.text("9:00 - 17:00");
          $output.style.marginTop = "12px";
          $output.style.fontWeight = "500";

          const $slider = TwoWaySlider.Default.makeWith({
            min: 0,
            max: 24,
            minWidth: 1,
            rangeStart: 9,
            rangeEnd: 17,
            showTooltip: true,
            onRangeChanged: (start, end) => {
              const formatHour = (h: number) => {
                const hour = Math.floor(h);
                return `${hour}:00`;
              };
              $output.textContent = `${formatHour(start)} - ${formatHour(end)}`;
            },
          });

          const $label = Typography.text("Time Range (24hr)");
          $label.style.marginBottom = "8px";
          $label.style.color = "var(--text-sec)";
          $label.style.fontSize = "0.875rem";

          $container.appendChild($label);
          $container.appendChild($slider);
          $container.appendChild($output);
          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Multiple Default Sliders",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "24px";

          const ranges = [
            {
              label: "Temperature (°C)",
              min: -20,
              max: 50,
              minWidth: 5,
              start: 15,
              end: 25,
            },
            {
              label: "Humidity (%)",
              min: 0,
              max: 100,
              minWidth: 10,
              start: 40,
              end: 60,
            },
            {
              label: "Pressure (kPa)",
              min: 90,
              max: 110,
              minWidth: 2,
              start: 98,
              end: 102,
            },
          ];

          ranges.forEach(({ label, min, max, minWidth, start, end }) => {
            const $group = Div.make();

            const $label = Typography.text(label);
            $label.style.marginBottom = "8px";
            $label.style.fontSize = "0.875rem";
            $label.style.color = "var(--text-sec)";

            const $slider = TwoWaySlider.Default.makeWith({
              min,
              max,
              minWidth,
              rangeStart: start,
              rangeEnd: end,
              showTooltip: true,
            });

            $group.appendChild($label);
            $group.appendChild($slider);
            $container.appendChild($group);
          });

          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Multiple Thick Sliders",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "16px";

          const configs = [
            {
              label: "Working Hours",
              min: 0,
              max: 24,
              minWidth: 1,
              start: 9,
              end: 17,
            },
            {
              label: "Age Range",
              min: 0,
              max: 100,
              minWidth: 5,
              start: 25,
              end: 65,
            },
            {
              label: "Price Filter",
              min: 0,
              max: 1000,
              minWidth: 50,
              start: 200,
              end: 600,
            },
          ];

          configs.forEach(({ label, min, max, minWidth, start, end }) => {
            const $slider = TwoWaySlider.Thick.makeWith({
              min,
              max,
              minWidth,
              rangeStart: start,
              rangeEnd: end,
              showTooltip: true,
            });

            const $label = Typography.text(label);
            $label.style.color = "var(--text-ter)";
            $label.style.fontSize = "var(--h6-size)";
            $slider.appendChild($label);

            $container.appendChild($slider);
          });

          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Responsive Width (ResizeObserver)",
        render: () => {
          const $wrapper = Div.make();

          const $container = Div.make();
          $container.style.cssText = `
            border: 1px solid #ddd;
            padding: 20px;
            transition: width 0.3s ease;
            width: 300px;
            border-radius: 8px;
            background: #f9f9f9;
          `;

          const $controlsContainer = Row.make();
          $controlsContainer.style.cssText = `
            gap: 10px;
            margin-bottom: 20px;
            align-items: center;
          `;

          const $widthDisplay = document.createElement("span");
          $widthDisplay.style.cssText = `
            font-size: 14px;
            color: #666;
            margin-left: auto;
            font-weight: 500;
          `;
          $widthDisplay.textContent = "Width: 300px";

          const createButton = (label: string, width: number) => {
            const $btn = Button.makeLight();
            $btn.textContent = label;
            $btn.style.cssText = "padding: 6px 12px; font-size: 14px;";
            $btn.onclick = () => {
              $container.style.width = `${width}px`;
              $widthDisplay.textContent = `Width: ${width}px`;
            };
            return $btn;
          };

          $controlsContainer.appendChild(createButton("300px", 300));
          $controlsContainer.appendChild(createButton("400px", 400));
          $controlsContainer.appendChild(createButton("500px", 500));
          $controlsContainer.appendChild(createButton("600px", 600));
          $controlsContainer.appendChild($widthDisplay);

          // Default TwoWaySlider
          const $label1 = Typography.text("Default TwoWaySlider");
          $label1.style.cssText = "margin-bottom: 10px; font-weight: 500;";

          const $output1 = Typography.text("Range: 20 - 80");
          $output1.style.cssText =
            "margin-top: 8px; font-size: 14px; color: #666;";

          const $slider1 = TwoWaySlider.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 20,
            rangeEnd: 80,
            showTooltip: true,
            onRangeChanged: (start, end) => {
              $output1.textContent = `Range: ${Math.round(start)} - ${Math.round(end)}`;
            },
          });

          // Thick TwoWaySlider
          const $label2 = Typography.text("Thick TwoWaySlider");
          $label2.style.cssText =
            "margin-top: 30px; margin-bottom: 10px; font-weight: 500;";

          const $output2 = Typography.text("Hours: 9 - 17");
          $output2.style.cssText =
            "margin-top: 8px; font-size: 14px; color: #666;";

          const $slider2 = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 24,
            minWidth: 1,
            rangeStart: 9,
            rangeEnd: 17,
            snap: Array.from({ length: 25 }, (_, i) => i),
            renderSnaps: true,
            renderSnapIndicators: (value) => value % 6 === 0,
            showTooltip: true,
            onRangeChanged: (start, end) => {
              $output2.textContent = `Hours: ${Math.round(start)} - ${Math.round(end)}`;
            },
          });

          $wrapper.appendChild($controlsContainer);
          $wrapper.appendChild($container);

          $container.appendChild($label1);
          $container.appendChild($slider1);
          $container.appendChild($output1);
          $container.appendChild($label2);
          $container.appendChild($slider2);
          $container.appendChild($output2);

          return $wrapper;
        },
      },
      {
        title: "No Initial Animation Test",
        render: () => {
          const $container = Column.make();
          $container.style.gap = "20px";

          const $info = Typography.text(
            "The sliders below should appear instantly without any animation when first rendered:",
          );
          $info.style.cssText = "margin-bottom: 10px; color: #666;";

          // Default slider
          const $defaultLabel = Typography.text(
            "Default Slider (no initial animation)",
          );
          $defaultLabel.style.cssText = "font-weight: 500; margin-bottom: 8px;";

          const $defaultSlider = TwoWaySlider.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 30,
            rangeEnd: 70,
            showTooltip: true,
          });

          // Thick slider
          const $thickLabel = Typography.text(
            "Thick Slider (no initial animation)",
          );
          $thickLabel.style.cssText =
            "font-weight: 500; margin-bottom: 8px; margin-top: 20px;";

          const $thickSlider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 40,
            rangeEnd: 60,
            showTooltip: true,
          });

          $container.appendChild($info);
          $container.appendChild($defaultLabel);
          $container.appendChild($defaultSlider);
          $container.appendChild($thickLabel);
          $container.appendChild($thickSlider);

          return Storybook.fill($container, "320px");
        },
      },
    ];
  }
}

export class ThickTwoWaySliderStoryBook extends Storybook.Default {
  title(): string {
    return "Thick Two-Way Slider";
  }

  tags(): string[] {
    return ["std-thick-two-way-slider"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Thick Slider",
        render: () => {
          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 25,
            rangeEnd: 75,
            showTooltip: true,
          });

          const $label = Typography.text("Range Selection");
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "Narrow Range",
        render: () => {
          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 5,
            rangeStart: 48,
            rangeEnd: 53,
            showTooltip: true,
          });

          const $label = Typography.text("Precision Range");
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "Time of Day Selector (Half-Hour Snaps)",
        render: () => {
          const $container = Div.make();

          // Generate snap points for every half hour (0, 0.5, 1, 1.5, ..., 23.5, 24)
          const halfHourSnaps: number[] = [];
          for (let i = 0; i <= 48; i++) {
            halfHourSnaps.push(i * 0.5);
          }

          const $output = Typography.text("9:00 AM - 5:00 PM");
          $output.style.marginTop = "16px";
          $output.style.fontSize = "1rem";
          $output.style.fontWeight = "500";

          const formatTime = (hour: number): string => {
            const h = Math.floor(hour);
            const m = Math.round((hour - h) * 60);
            const period = h >= 12 ? "PM" : "AM";
            const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
            return `${displayHour}:${m.toString().padStart(2, "0")} ${period}`;
          };

          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 24,
            minWidth: 0.5, // Minimum 30 minutes
            rangeStart: 9,
            rangeEnd: 17,
            snap: halfHourSnaps,
            renderSnaps: true,
            renderSnapIndicators: (value) => {
              // Only show indicators for whole hours divisible by 4 (0, 4, 8, 12, 16, 20)
              return value % 4 === 0 && value % 1 === 0;
            },
            showTooltip: true,
            onRangeChanged: (start, end) => {
              $output.textContent = `${formatTime(start)} - ${formatTime(end)}`;
            },
          });

          const $label = Typography.text("Business Hours");
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          $container.appendChild($slider);
          $container.appendChild($output);
          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Custom Snap Points",
        render: () => {
          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 10,
            rangeStart: 25,
            rangeEnd: 75,
            snap: [0, 10, 25, 50, 75, 90, 100],
            renderSnaps: true,
            showTooltip: true,
          });

          const $label = Typography.text("Custom Intervals");
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "Dense Snaps with Sparse Indicators",
        render: () => {
          // Create snap points every 5 units
          const denseSnaps: number[] = [];
          for (let i = 0; i <= 100; i += 5) {
            denseSnaps.push(i);
          }

          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 5,
            rangeStart: 20,
            rangeEnd: 80,
            snap: denseSnaps,
            renderSnaps: true,
            renderSnapIndicators: (value, index) => {
              // Only show every 4th indicator (every 20 units)
              return index % 4 === 0;
            },
            showTooltip: true,
          });

          const $label = Typography.text(
            "Every 5 (snap) / Every 20 (indicator)",
          );
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          return Storybook.fill($slider, "320px");
        },
      },
      {
        title: "Very Narrow Range (External Handles)",
        render: () => {
          const $container = Div.make();

          const $slider = TwoWaySlider.Thick.makeWith({
            min: 0,
            max: 100,
            minWidth: 1,
            rangeStart: 49,
            rangeEnd: 51,
            showTooltip: true,
          });

          const $label = Typography.text("Precision Selection");
          $label.style.color = "var(--text-ter)";
          $label.style.fontSize = "var(--h6-size)";
          $slider.appendChild($label);

          const $info = Typography.text(
            "Handles positioned outside when range is narrow",
          );
          $info.style.marginTop = "12px";
          $info.style.fontSize = "0.75rem";
          $info.style.color = "var(--text-ter)";

          $container.appendChild($slider);
          $container.appendChild($info);
          return Storybook.fill($container, "320px");
        },
      },
      {
        title: "Without Tooltip",
        render: () => {
          const $container = Div.make();

          const $displayRow = Row.make();
          $displayRow.style.cssText = `
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
          `;

          const $label = Typography.text("Temperature Range");
          $label.style.cssText = "font-weight: 500;";

          const $valueDisplay = Typography.text("15°C - 25°C");
          $valueDisplay.style.cssText =
            "color: var(--text-sec); font-size: 14px;";

          $displayRow.appendChild($label);
          $displayRow.appendChild($valueDisplay);

          const $slider = TwoWaySlider.Thick.makeWith({
            min: -10,
            max: 40,
            minWidth: 5,
            rangeStart: 15,
            rangeEnd: 25,
            showTooltip: false, // Disable tooltip
            onRangeChanged: (start, end) => {
              $valueDisplay.textContent = `${Math.round(start)}°C - ${Math.round(end)}°C`;
            },
          });

          // Set fixed width to prevent layout thrashing when label changes
          $slider.style.width = "280px";

          $container.appendChild($displayRow);
          $container.appendChild($slider);

          return $container;
        },
      },
    ];
  }
}
