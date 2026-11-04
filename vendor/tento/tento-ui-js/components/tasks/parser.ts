import { Tracing } from "@tento-core/tracing";

interface Task {
  id: string;
  description: string;
  priority?: string;
  tags?: string[];
  dependsOn?: string[];
  finishBy?: string;
  schedule?: string;
}

export namespace Task {
  export function parseTasks(markdown: string): Task[] {
    const lines = markdown.split("\n");
    const tasks: Task[] = [];
    let currentTask: Task | null = null;

    for (let line of lines) {
      Tracing.dev(`${line} ==> "${line.trim()}"`);

      line = line.trim();
      if (line.startsWith("*")) {
        line = line.slice(1);
      }
      line = line.trim();

      const taskMatch = line.match(/([tT]\d*): (.+)/);
      if (taskMatch) {
        if (currentTask) {
          tasks.push(currentTask);
        }
        currentTask = { id: taskMatch[1], description: taskMatch[2] };
        continue;
      }

      if (line.startsWith("@") && currentTask) {
        const attrMatch = line.trim().match(/@([-\w]+): \s*(.+)/);
        if (attrMatch) {
          const key = attrMatch[1];
          const value = attrMatch[2];
          switch (key) {
            case "priority":
              currentTask.priority = value;
              break;
            case "tags":
              currentTask.tags = value
                .split("#")
                .filter((tag) => tag.trim())
                .map((tag) => `#${tag.trim()}`);
              break;
            case "depends-on":
              currentTask.dependsOn = value.split(",").map((dep) => dep.trim());
              break;
            case "finish-by":
              currentTask.finishBy = value;
              break;
            case "schedule":
              currentTask.schedule = value;
              break;
          }
        }
      }
    }

    // Push the last task if there's any
    if (currentTask) {
      tasks.push(currentTask);
    }

    return tasks;
  }
}

// const TEST = `
// * T: go to the gym
//     * @finish-by: friday
// * T123: hiyo
//     * @depends-on: T12, T24, T22/yuzu
//     * @priority: high
//     * @tags: #code

// T443: groceries @priority: high @schedule: auto
// `;
// const tasks = Task.parseTasks(TEST);

// Tracing.dev(tasks);
