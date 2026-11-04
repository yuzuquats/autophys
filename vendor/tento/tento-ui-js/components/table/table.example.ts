import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Column, Row } from "../../component-builtin";
import { Button } from "../button/button";
import { Switch } from "../controls/switch";
import { PropertyList } from "../input/property-list";
import { Table } from "./table";
import { Toast } from "../toast/toast";
import { Rational } from "@tento-core/rational";
import { ArrowsAngleExpandIcon } from "../../ui/icons";

interface Person extends Identifiable<string> {
  id: string;
  name: string;
  age: number;
  email: string;
  department: string;
}

interface PersonWithPosition extends Person {
  position: Rational;
}

export namespace Person {
  export function getTableSpec<T extends Person>(): Table.Spec<T> {
    return {
      style: {
        cellPadding: 4,
      },
      floatingCta: {
        icon: ArrowsAngleExpandIcon,
        onClick: (person: T) => {
          Toast.makeWith({
            title: `Clicked on ${person.name}`,
          }).show();
        },
      },
      columns: [
        {
          id: "name",
          label: "Name",
          primary: true,
          sortComparator: (a, b) => a.name.localeCompare(b.name),
          make: () => {
            const $t = Typography.p("");
            $t.classList.add("attr-name", "max-lines-1");
            $t.assignStyles({
              width: "100%",
              textOverflow: "ellipsis",
              overflow: "hidden",
            });
            return $t;
          },
          bind: ($t, person: T) => {
            $t.textContent = person.name;
          },
        },
        {
          id: "email",
          label: "Email",
          sortComparator: (a, b) => a.email.localeCompare(b.email),
          make: () => {
            const $t = Typography.p("");
            $t.classList.add("attr-email", "max-lines-1");
            $t.assignStyles({
              width: "100%",
              textOverflow: "ellipsis",
              overflow: "hidden",
            });
            return $t;
          },
          bind: ($t, person: T) => {
            $t.textContent = person.email;
          },
          layout: ($t, layoutStyle: Table.LayoutStyle) => {
            $t.assignStyles({
              "--font-size":
                layoutStyle === "inline" ? "var(--small-size)" : "",
              color:
                layoutStyle === "inline"
                  ? "var(--text-ter)"
                  : "var(--text-pri)",
            });
          },
        },
        {
          id: "age",
          label: "Age",
          sortComparator: (a, b) => a.age - b.age,
          make: () => {
            const $t = Typography.p("");
            $t.classList.add("attr-age", "max-lines-1");
            return $t;
          },
          bind: ($t, person: T) => {
            $t.textContent = person.age.toString();
          },
          layout: ($t, layoutStyle: Table.LayoutStyle) => {
            $t.assignStyles({
              "--font-size":
                layoutStyle === "inline" ? "var(--small-size)" : "",
              color:
                layoutStyle === "inline"
                  ? "var(--text-ter)"
                  : "var(--text-pri)",
            });
          },
        },
        {
          id: "department",
          label: "Department",
          sortComparator: (a, b) => a.department.localeCompare(b.department),
          make: () => {
            const $t = Typography.p("");
            $t.classList.add("attr-department", "max-lines-1");
            $t.assignStyles({
              width: "100%",
              textOverflow: "ellipsis",
              overflow: "hidden",
            });
            return $t;
          },
          bind: ($t, person: T) => {
            $t.textContent = person.department;
          },
          layout: ($t, layoutStyle: Table.LayoutStyle) => {
            $t.assignStyles({
              "--font-size":
                layoutStyle === "inline" ? "var(--small-size)" : "",
              color:
                layoutStyle === "inline"
                  ? "var(--text-ter)"
                  : "var(--text-pri)",
            });
          },
        },
      ],
    };
  }

  export const TABLE_SPEC = getTableSpec<Person>();
}

const SAMPLE_DATA: Person[] = [
  {
    id: "1",
    name: "John Doe",
    age: 30,
    email: "john@example.com",
    department: "Engineering",
  },
  {
    id: "2",
    name: "Jane Smith",
    age: 25,
    email: "jane@example.com",
    department: "Marketing",
  },
  {
    id: "3",
    name: "Bob Johnson",
    age: 35,
    email: "bob@example.com",
    department: "Sales",
  },
  {
    id: "4",
    name: "Alice Brown",
    age: 28,
    email: "alice@example.com",
    department: "HR",
  },
  {
    id: "5",
    name: "Charlie Wilson",
    age: 32,
    email: "charlie@example.com",
    department: "Engineering",
  },
  {
    id: "6",
    name: "Bobby",
    age: 32,
    email: "bobby@example.com",
    department: "Engineering",
  },
  {
    id: "7",
    name: "Andrew",
    age: 32,
    email: "andrew@example.com",
    department: "Engineering",
  },
  {
    id: "8",
    name: "Dick",
    age: 32,
    email: "dick@example.com",
    department: "Engineering",
  },
];

export class TableStoryBook extends Storybook.Default {
  title(): string {
    return "Table";
  }

  tags(): string[] {
    return ["std-table", "std-table-header", "std-table-header-column", "std-table-body", "std-table-body-row"];
  }

  description(): Option<string> {
    return `A virtualized table component with support for large datasets.

**Features:**
- Column sorting with custom comparators
- Card style and inline layout modes
- Drag-to-reorder rows with rational positioning
- Row grouping with per-group filtering
- Configurable row heights and dividers
- Named section headers and expandable row details
- Horizontal scroll with edge shadows
- Floating row CTAs on hover`;
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Grouped Table with Drag to Reorder",
        render: () => {
          interface PersonWithPositionAndType extends PersonWithPosition {
            isBuiltin?: boolean;
          }

          let data: PersonWithPositionAndType[] = [
            ...SAMPLE_DATA.slice(0, 3).map((person, idx) => ({
              ...person,
              department: "Engineering",
              position: new Rational(idx + 2, 1),
              isBuiltin: false,
            })),
            ...SAMPLE_DATA.slice(3).map((person, idx) => ({
              ...person,
              department: "Marketing",
              position: new Rational(idx, 1),
              isBuiltin: false,
            })),
          ];

          const sortByPosition = (items: PersonWithPositionAndType[]) => {
            return [...items].sort((a, b) =>
              Rational.compare(a.position, b.position),
            );
          };

          const engineeringGroup: Table.Group<PersonWithPositionAndType> = {
            id: "engineering",
            filter: (person) => person.department === "Engineering",
          };

          const marketingGroup: Table.Group<PersonWithPositionAndType> = {
            id: "marketing",
            filter: (person) => person.department === "Marketing",
          };

          let $table: Table<PersonWithPositionAndType>;
          const spec: Table.Spec<PersonWithPositionAndType> = {
            ...Person.getTableSpec<PersonWithPositionAndType>(),
            groups: [engineeringGroup, marketingGroup],
            delegate: {
              canReorder: (item) => !item.isBuiltin,
              onReorder: async (
                draggedItem,
                beforeItem,
                afterItem,
                _newItemOrder,
              ) => {
                if (draggedItem.isBuiltin) {
                  return false;
                }

                const newPosition = Rational.midpoint(
                  afterItem?.position,
                  beforeItem?.position,
                );
                draggedItem.position = newPosition;

                Toast.makeWith({
                  title: `Reordered ${draggedItem.name} to position ${Rational.toString(newPosition)}`,
                }).show();

                return true;
              },
            },
          };

          const tvm = Table.ViewModel.makeDefault(spec);
          return ($table = Table.makeTyped<PersonWithPositionAndType>()
            .bind(tvm)
            .bindItems(sortByPosition(data))
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            }));
        },
      },
      {
        title: "Table with Controls",
        render: () => {
          const tvm = Table.ViewModel.makeDefault(Person.TABLE_SPEC);
          const $table = Table.makeTyped<Person>()
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            })
            .bind(tvm)
            .bindItems([...SAMPLE_DATA]);

          const $cardStyleSwitch = Switch.make();
          $cardStyleSwitch.bind({
            checked: false,
            onChange: (on) => {
              tvm.updateCardStyle(on ? "card" : "default");
            },
          });

          const $layoutStyleSwitch = Switch.make();
          $layoutStyleSwitch.bind({
            checked: false,
            onChange: (on) => {
              tvm.updateLayoutStyle(on ? "inline" : "default");
            },
          });

          const $dividersSwitch = Switch.make();
          $dividersSwitch.bind({
            checked: true,
            onChange: (on) => {
              tvm.style.showRowDividers = on;
              $table.bindItems([...SAMPLE_DATA]);
            },
          });

          const $propertyList = PropertyList.makeWith({
            cardStyle: {
              label: "Card Style",
              $e: $cardStyleSwitch,
              order: 0,
            },
            layoutStyle: {
              label: "Layout Style",
              $e: $layoutStyleSwitch,
              order: 1,
            },
            showDividers: {
              label: "Show Row Dividers",
              $e: $dividersSwitch,
              order: 2,
            },
          });

          return {
            $content: $table,
            $controls: $propertyList,
          };
        },
      },
      {
        title: "Basic Table",
        render: () => {
          return Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(Person.TABLE_SPEC))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            });
        },
      },
      {
        title: "Sectioned Table with Row Details",
        render: () => {
          const expandedIds = new Set<string>(["2"]);
          let $table: Table<Person>;

          const makeHeader = (label: string): HTMLElement => {
            const $header = Row.make();
            $header.assignStyles({
              alignItems: "center",
              minHeight: "36px",
              padding: "4px 8px",
            });
            $header.append(
              Typography.h6(label),
              document.createElement("std-spacer"),
              Button.makeWith("Run", { type: "flat", onClick: () => {} }),
            );
            return $header;
          };

          const spec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            groups: [
              {
                id: "engineering",
                filter: (person) => person.department === "Engineering",
                makeHeader: () => makeHeader("Engineering"),
              },
              {
                id: "other",
                filter: (person) => person.department !== "Engineering",
                makeHeader: () => makeHeader("Other teams"),
              },
            ],
            delegate: {
              onRowClick: (person) => {
                if (expandedIds.has(person.id)) expandedIds.delete(person.id);
                else expandedIds.add(person.id);
                $table.updateRowDetail(person.id);
              },
              makeRowDetail: (person) => {
                if (!expandedIds.has(person.id)) return null;
                const $detail = Column.make();
                $detail.assignStyles({
                  boxSizing: "border-box",
                  gap: "6px",
                  padding: "12px 16px 14px 28px",
                  background: "var(--bg-surface-light)",
                  borderBottom: "1px solid var(--divider)",
                });
                $detail.append(
                  Typography.small("Row detail"),
                  Typography.p(`${person.email} · ${person.department}`),
                );
                return $detail;
              },
            },
          };

          $table = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(spec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({
              width: "100%",
              height: "520px",
              maxWidth: "800px",
            });
          return $table;
        },
      },
      {
        title: "Card Style Table",
        render: () => {
          const spec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, card: "card" },
          };
          return Table.makeTyped<Person>()
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            })
            .bind(Table.ViewModel.makeDefault(spec))
            .bindItems([...SAMPLE_DATA]);
        },
      },
      {
        title: "Add/Remove Items",
        render: () => {
          let data: Person[] = [...SAMPLE_DATA];
          let nextId = SAMPLE_DATA.length + 1;

          const $table = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(Person.TABLE_SPEC))
            .bindItems(data);

          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWithLight("Add Row", {
              onClick: () => {
                const newPerson: Person = {
                  id: String(nextId++),
                  name: `Person ${nextId}`,
                  age: Math.floor(Math.random() * 30) + 20,
                  email: `person${nextId}@example.com`,
                  department: ["Engineering", "Marketing", "Sales", "HR"][
                    Math.floor(Math.random() * 4)
                  ],
                };
                data.push(newPerson);
                $table.bindItems(data);
              },
            }),
            Button.makeWithLight("Remove Row", {
              onClick: () => {
                if (data.length <= 0) return;
                data.pop();
                $table.bindItems(data);
              },
            }),
          );

          return {
            $content: $table.assignStyles({
              width: "100%",
              maxWidth: "400px",
            }),
            $controls,
          };
        },
      },
      {
        title: "Horizontal Scroll with Shadows",
        render: () => {
          const spec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, minViewportWidth: 1000 },
          };
          return Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(spec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({
              width: "100%",
              maxWidth: "600px",
            });
        },
      },
      {
        title: "Drag to Reorder",
        render: () => {
          let data: PersonWithPosition[] = SAMPLE_DATA.map((person, idx) => ({
            ...person,
            position: new Rational(idx, 1),
          }));

          const sortByPosition = (items: PersonWithPosition[]) => {
            return [...items].sort((a, b) =>
              Rational.compare(a.position, b.position),
            );
          };

          const spec: Table.Spec<PersonWithPosition> = {
            ...Person.getTableSpec<PersonWithPosition>(),
            delegate: {
              onReorder: async (
                draggedItem,
                beforeItem,
                afterItem,
                _newItemOrder,
              ) => {
                const newPosition = Rational.midpoint(
                  beforeItem?.position,
                  afterItem?.position,
                );
                draggedItem.position = newPosition;

                Toast.makeWith({
                  title: `Reordered ${draggedItem.name} to position ${Rational.toString(newPosition)}`,
                }).show();

                $table.bindItems(sortByPosition(data));
                return false;
              },
            },
          };

          const $table = Table.makeTyped<PersonWithPosition>()
            .bind(Table.ViewModel.makeDefault(spec))
            .bindItems(sortByPosition(data))
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            });

          return $table;
        },
      },
      {
        title: "With / Without Row Dividers",
        render: () => {
          const $col = document.createElement("std-col");
          $col.assignStyles({
            gap: "24px",
            width: "100%",
            maxWidth: "800px",
          });

          const specWithDividers: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, showRowDividers: true },
          };
          const $withDividers = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(specWithDividers))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({ width: "100%" });

          const specWithoutDividers: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, showRowDividers: false },
          };
          const $withoutDividers = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(specWithoutDividers))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({ width: "100%" });

          $col.append(
            Typography.h6("With Row Dividers (default)"),
            $withDividers,
            Typography.h6("Without Row Dividers"),
            $withoutDividers,
          );

          return $col;
        },
      },
      {
        title: "Grouped Table",
        render: () => {
          const engineeringGroup: Table.Group<Person> = {
            id: "engineering",
            filter: (person) => person.department === "Engineering",
          };

          const marketingGroup: Table.Group<Person> = {
            id: "marketing",
            filter: (person) => person.department === "Marketing",
          };

          const otherGroup: Table.Group<Person> = {
            id: "other",
            filter: (person) =>
              person.department !== "Engineering" &&
              person.department !== "Marketing",
          };

          const groupedSpec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            groups: [engineeringGroup, marketingGroup, otherGroup],
          };

          const $table = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(groupedSpec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            });

          return $table;
        },
      },
      {
        title: "Grouped Table with Sorting",
        render: () => {
          const youngGroup: Table.Group<Person> = {
            id: "young",
            filter: (person) => person.age < 30,
          };

          const olderGroup: Table.Group<Person> = {
            id: "older",
            filter: (person) => person.age >= 30,
          };

          const groupedSpec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            groups: [youngGroup, olderGroup],
          };

          const $table = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(groupedSpec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({
              width: "100%",
              maxWidth: "800px",
            });

          const $col = document.createElement("std-col");
          $col.assignStyles({
            gap: "12px",
            width: "100%",
            maxWidth: "800px",
          });

          $col.append(
            Typography.p(
              "Try sorting by name or age - items sort within their groups",
            ),
            $table,
          );

          return $col;
        },
      },
      {
        title: "Custom Row Heights",
        render: () => {
          const $col = document.createElement("std-col");
          $col.assignStyles({
            gap: "24px",
            width: "100%",
            maxWidth: "800px",
          });

          const compactSpec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, rowHeight: 32 },
          };
          const $compact = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(compactSpec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({ width: "100%" });

          const defaultSpec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, rowHeight: 40 },
          };
          const $default = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(defaultSpec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({ width: "100%" });

          const spaciousSpec: Table.Spec<Person> = {
            ...Person.TABLE_SPEC,
            style: { ...Person.TABLE_SPEC.style, rowHeight: 56 },
          };
          const $spacious = Table.makeTyped<Person>()
            .bind(Table.ViewModel.makeDefault(spaciousSpec))
            .bindItems([...SAMPLE_DATA])
            .assignStyles({ width: "100%" });

          $col.append(
            Typography.h6("Compact (32px)"),
            $compact,
            Typography.h6("Default (40px)"),
            $default,
            Typography.h6("Spacious (56px)"),
            $spacious,
          );

          return $col;
        },
      },
    ];
  }
}
