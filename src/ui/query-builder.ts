import { App, Editor, MarkdownView, Modal, Notice, Setting } from "obsidian";
import { openFieldManager } from "ui/field-manager";
import { parseQuery } from "query/parse";
import { Field } from "expression/field";
import { Query, QueryOperation, QuerySortBy, NamedField } from "query/query";
import { Source } from "data-index/source";
import { FullIndex } from "data-index/index";
import { DateTime, Duration } from "luxon";
import { Link, Literal } from "data-model/value";

type QueryType = "list" | "table" | "task" | "calendar";
type SourceType = "folder" | "tag" | "file" | "incoming" | "outgoing" | "csv" | "custom";
type LogicalJoin = "AND" | "OR";

interface FieldDraft {
    expression: string;
    alias: string;
}

interface ConditionDraft {
    field: string;
    operator: "=" | "!=" | ">" | ">=" | "<" | "<=";
    value: string;
    join: LogicalJoin;
    negate: boolean;
}

interface SortDraft {
    field: string;
    direction: "ascending" | "descending";
}

interface SourceDraft {
    type: SourceType;
    value: string;
    join: LogicalJoin;
    negate: boolean;
}

interface QueryDraft {
    type: QueryType;
    withoutId: boolean;
    listFormat: string;
    calendarField: string;
    tableFields: FieldDraft[];
    sources: SourceDraft[];
    conditions: ConditionDraft[];
    sorts: SortDraft[];
    limit: string;
    flatten: string;
    flattenAlias: string;
    group: string;
    groupAlias: string;
    advancedClauses: string[];
    originalOperationTypes: QueryOperation["type"][];
}

const COMMON_FIELDS = [
    "file.name",
    "file.link",
    "file.path",
    "file.folder",
    "file.ext",
    "file.ctime",
    "file.mtime",
    "file.size",
    "file.day",
    "file.cday",
    "file.tags",
    "file.etags",
    "file.aliases",
    "file.inlinks",
    "file.outlinks",
    "file.tasks",
    "file.lists",
    "file.frontmatter",
    "file.starred",
];

const OPERATORS: Array<ConditionDraft["operator"]> = ["=", "!=", ">", ">=", "<", "<="];

const VIEW_OPTIONS: Record<QueryType, string> = {
    table: "Table",
    list: "List",
    task: "Task",
    calendar: "Calendar",
};

const SOURCE_OPTIONS: Record<SourceType, string> = {
    folder: "Folder",
    tag: "Tag",
    file: "File",
    incoming: "Incoming links",
    outgoing: "Outgoing links",
    csv: "CSV",
    custom: "Custom source",
};

function escapeString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeLiteral(value: Literal): string {
    if (value === null) return "null";
    if (typeof value === "string") return escapeString(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof DateTime) return value.toISO() ?? value.toFormat("yyyy-MM-dd");
    if (value instanceof Duration) return value.toISO() ?? "0 seconds";
    if (value instanceof Link) return value.markdown();
    if (Array.isArray(value)) return `[${value.map(serializeLiteral).join(", ")}]`;
    if (value instanceof HTMLElement) return escapeString(value.outerHTML);
    if (typeof value === "object") {
        return `{ ${Object.entries(value as Record<string, Literal>)
            .map(([key, entry]) => `${key}: ${serializeLiteral(entry)}`)
            .join(", ")} }`;
    }
    return String(value);
}

function fieldPrecedence(field: Field): number {
    if (field.type !== "binaryop") return 8;
    if (field.op === "|" || field.op === "&") return 1;
    if (["=", "!=", ">", ">=", "<", "<="].includes(field.op)) return 2;
    if (["+", "-"].includes(field.op)) return 3;
    return 4;
}

function serializeField(field: Field, parentPrecedence = 0): string {
    switch (field.type) {
        case "variable":
            return field.name;
        case "literal":
            return serializeLiteral(field.value);
        case "negated": {
            const value = `!${serializeField(field.child, 8)}`;
            return parentPrecedence > 8 ? `(${value})` : value;
        }
        case "binaryop": {
            const precedence = fieldPrecedence(field);
            const value = `${serializeField(field.left, precedence)} ${field.op} ${serializeField(
                field.right,
                precedence + 1
            )}`;
            return parentPrecedence > precedence ? `(${value})` : value;
        }
        case "index":
            return `${serializeField(field.object, 8)}[${serializeField(field.index)}]`;
        case "function":
            return `${serializeField(field.func, 8)}(${field.arguments
                .map(argument => serializeField(argument))
                .join(", ")})`;
        case "lambda":
            return `(${field.arguments.join(", ")}) => ${serializeField(field.value)}`;
        case "list":
            return `[${field.values.map(value => serializeField(value)).join(", ")}]`;
        case "object":
            return `{ ${Object.entries(field.values)
                .map(([key, value]) => `${key}: ${serializeField(value)}`)
                .join(", ")} }`;
        default:
            return "";
    }
}

function serializeNamedField(field: NamedField): string {
    const expression = serializeField(field.field);
    return field.name === expression ? expression : `${expression} AS ${field.name}`;
}

function serializeSource(source: Source): string {
    switch (source.type) {
        case "folder":
            return escapeString(source.folder);
        case "tag":
            return source.tag;
        case "csv":
            return `csv(${escapeString(source.path)})`;
        case "link":
            return source.direction === "incoming"
                ? `[[${source.file}]]`
                : `outgoing([[${source.file}]])`;
        case "empty":
            return "";
        case "negate":
            return `-${serializeSource(source.child)}`;
        case "binaryop":
            return `${serializeSource(source.left)} ${source.op} ${serializeSource(source.right)}`;
    }
}


function sourceDraftFromSource(source: Source, join: LogicalJoin = "AND", negate = false): SourceDraft[] {
    if (source.type === "binaryop") {
        const left = sourceDraftFromSource(source.left);
        const right = sourceDraftFromSource(source.right);
        if (right.length > 0) right[0].join = source.op === "&" ? "AND" : "OR";
        return left.concat(right);
    }

    if (source.type === "negate") {
        return sourceDraftFromSource(source.child, join, true);
    }

    switch (source.type) {
        case "folder":
            return [{ type: "folder", value: source.folder, join, negate }];
        case "tag":
            return [{ type: "tag", value: source.tag, join, negate }];
        case "csv":
            return [{ type: "csv", value: source.path, join, negate }];
        case "link":
            return [
                {
                    type: source.direction === "incoming" ? "incoming" : "outgoing",
                    value: source.file,
                    join,
                    negate,
                },
            ];
        default:
            return [{ type: "custom", value: serializeSource(source), join, negate: false }];
    }
}

function queryToDraft(query: Query, fields: string[]): QueryDraft {
    const header = query.header;
    const draft: QueryDraft = {
        type: header.type,
        withoutId: header.type === "table" || header.type === "list" ? !header.showId : false,
        listFormat: header.type === "list" && header.format ? serializeField(header.format) : "",
        calendarField: header.type === "calendar" ? serializeNamedField(header.field) : "file.day",
        tableFields:
            header.type === "table"
                ? header.fields.map(field => {
                      const expression = serializeField(field.field);
                      return { expression, alias: field.name === expression ? "" : field.name };
                  })
                : [],
        sources: sourceDraftFromSource(query.source),
        conditions: [],
        sorts: [],
        limit: "",
        flatten: "",
        flattenAlias: "",
        group: "",
        groupAlias: "",
        advancedClauses: [],
        originalOperationTypes: query.operations.map(operation => operation.type),
    };

    for (const operation of query.operations) {
        switch (operation.type) {
            case "where": {
                const expression = serializeField(operation.clause);
                const match = expression.match(/^(!?)(.+?)\s*(=|!=|>=|<=|>|<)\s*(.+)$/);
                if (match) {
                    draft.conditions.push({
                        field: match[2].trim(),
                        operator: match[3] as ConditionDraft["operator"],
                        value: match[4].trim(),
                        join: "AND",
                        negate: match[1] === "!",
                    });
                } else {
                    draft.advancedClauses.push(`WHERE ${expression}`);
                }
                break;
            }
            case "sort":
                draft.sorts.push(
                    ...operation.fields.map((sort: QuerySortBy) => ({
                        field: serializeField(sort.field),
                        direction: sort.direction,
                    }))
                );
                break;
            case "limit":
                draft.limit = serializeField(operation.amount);
                break;
            case "flatten":
                draft.flatten = serializeField(operation.field.field);
                draft.flattenAlias =
                    operation.field.name === draft.flatten ? "" : operation.field.name;
                break;
            case "group":
                draft.group = serializeField(operation.field.field);
                draft.groupAlias =
                    operation.field.name === draft.group ? "" : operation.field.name;
                break;
            case "extract":
                // Extract is an internal execution operation and is not directly user-authored.
                break;
        }
    }

    if (draft.sources.length === 0) {
        draft.sources.push({ type: "folder", value: "", join: "AND", negate: false });
    }

    // Avoid unused parameter warnings while retaining a clear call contract.
    void fields;
    return draft;
}

function sourceDraftToText(source: SourceDraft): string {
    const value = source.value.trim();
    let result: string;

    switch (source.type) {
        case "folder":
            result = escapeString(value);
            break;
        case "tag":
            result = value.startsWith("#") ? value : `#${value}`;
            break;
        case "file":
            result = `[[${value.replace(/^\[\[|\]\]$/g, "")}]]`;
            break;
        case "incoming":
            result = `[[${value.replace(/^\[\[|\]\]$/g, "")}]]`;
            break;
        case "outgoing":
            result = `outgoing([[${value.replace(/^\[\[|\]\]$/g, "")}]])`;
            break;
        case "csv":
            result = `csv(${escapeString(value)})`;
            break;
        case "custom":
            result = value;
            break;
    }

    return source.negate ? `-${result}` : result;
}

function conditionsToExpression(conditions: ConditionDraft[]): string {
    return conditions
        .filter(condition => condition.field.trim() && condition.value.trim())
        .map((condition, index) => {
            const expression = `${condition.field.trim()} ${condition.operator} ${condition.value.trim()}`;
            const normalized = condition.negate ? `!(${expression})` : expression;
            if (index === 0) return normalized;
            return `${condition.join === "OR" ? "|" : "&"} ${normalized}`;
        })
        .join(" ");
}

function renderClauseByType(draft: QueryDraft, type: QueryOperation["type"]): string[] {
    switch (type) {
        case "where": {
            const expression = conditionsToExpression(draft.conditions);
            const advanced = draft.advancedClauses.filter(clause => clause.trim());
            const result: string[] = [];
            if (advanced.length > 0) result.push(...advanced);
            if (expression) result.push(`WHERE ${expression}`);
            return result;
        }
        case "sort":
            return draft.sorts.length
                ? [`SORT ${draft.sorts
                      .filter(sort => sort.field.trim())
                      .map(sort => `${sort.field.trim()} ${sort.direction === "ascending" ? "ASC" : "DESC"}`)
                      .join(", ")}`]
                : [];
        case "limit":
            return draft.limit.trim() ? [`LIMIT ${draft.limit.trim()}`] : [];
        case "flatten":
            return draft.flatten.trim()
                ? [
                      `FLATTEN ${draft.flatten.trim()}${
                          draft.flattenAlias.trim() ? ` AS ${draft.flattenAlias.trim()}` : ""
                      }`,
                  ]
                : [];
        case "group":
            return draft.group.trim()
                ? [
                      `GROUP BY ${draft.group.trim()}${
                          draft.groupAlias.trim() ? ` AS ${draft.groupAlias.trim()}` : ""
                      }`,
                  ]
                : [];
        case "extract":
            return [];
    }
}

function draftToText(draft: QueryDraft): string {
    const lines: string[] = [];

    if (draft.type === "table") {
        const fields = draft.tableFields
            .map(field => {
                const expression = field.expression.trim();
                if (!expression) return "";
                return field.alias.trim() ? `${expression} AS ${field.alias.trim()}` : expression;
            })
            .filter(Boolean)
            .join(", ");
        lines.push(`TABLE${draft.withoutId ? " WITHOUT ID" : ""}${fields ? ` ${fields}` : ""}`);
    } else if (draft.type === "list") {
        lines.push(
            `LIST${draft.withoutId ? " WITHOUT ID" : ""}${draft.listFormat.trim() ? ` ${draft.listFormat.trim()}` : ""}`
        );
    } else if (draft.type === "calendar") {
        lines.push(`CALENDAR ${draft.calendarField.trim() || "file.day"}`);
    } else {
        lines.push("TASK");
    }

    const sources = draft.sources.filter(source => source.value.trim() || source.type === "custom");
    if (sources.length > 0) {
        let expression = sourceDraftToText(sources[0]);
        for (let index = 1; index < sources.length; index++) {
            expression += ` ${sources[index].join === "OR" ? "|" : "&"} ${sourceDraftToText(sources[index])}`;
        }
        if (expression.trim()) lines.push(`FROM ${expression}`);
    }

    const operationTypes: QueryOperation["type"][] = draft.originalOperationTypes.length
        ? (Array.from(new Set(draft.originalOperationTypes)) as QueryOperation["type"][])
        : ["where", "flatten", "group", "sort", "limit"];

    const emitted = new Set<QueryOperation["type"]>();

    for (const type of operationTypes) {
        if (emitted.has(type)) continue;
        emitted.add(type);
        lines.push(...renderClauseByType(draft, type));
    }

    // New operations are appended in Dataview's conventional order.
    for (const type of ["where", "flatten", "group", "sort", "limit"] as QueryOperation["type"][]) {
        if (emitted.has(type)) continue;
        const clauses = renderClauseByType(draft, type);
        if (clauses.length > 0) lines.push(...clauses);
    }

    return lines.join("\n");
}

function findDataviewBlock(editor: Editor): { start: number; end: number; source: string } | null {
    const cursor = editor.getCursor().line;
    let start = -1;

    for (let line = cursor; line >= 0; line--) {
        const value = editor.getLine(line).trim().toLowerCase();
        if (/^```dataview\s*$/.test(value)) {
            start = line;
            break;
        }
        if (line < cursor && /^```/.test(value)) break;
    }

    if (start < 0) return null;

    for (let line = start + 1; line < editor.lineCount(); line++) {
        if (/^\s*```\s*$/.test(editor.getLine(line))) {
            const source = Array.from(
                { length: line - start - 1 },
                (_, index) => editor.getLine(start + 1 + index)
            ).join("\n");
            return { start, end: line, source };
        }
    }

    return null;
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
    const option = Array.from(select.options).find(entry => entry.value === value);
    if (option) {
        select.value = value;
        return;
    }

    const custom = document.createElement("option");
    custom.value = value;
    custom.text = value || "Custom expression…";
    select.appendChild(custom);
    select.value = value;
}

export class QueryBuilderModal extends Modal {
    private draft: QueryDraft;
    private editor: Editor | null;
    private block: { start: number; end: number; source: string } | null;
    private fieldSuggestions: string[];
    private previewEl: HTMLElement;
    private bodyEl: HTMLElement;

    public constructor(
        appRef: App,
        private index: FullIndex,
        initialQuery?: string,
        editor?: Editor
    ) {
        super(appRef);
        this.editor = editor ?? null;
        this.block = editor ? findDataviewBlock(editor) : null;
        this.fieldSuggestions = this.collectFields();

        const parsed = initialQuery ? parseQuery(initialQuery) : null;
        this.draft = parsed?.successful
            ? queryToDraft(parsed.value, this.fieldSuggestions)
            : {
                  type: "table",
                  withoutId: false,
                  listFormat: "",
                  calendarField: "file.day",
                  tableFields: [{ expression: "file.link", alias: "" }],
                  sources: [{ type: "folder", value: "", join: "AND", negate: false }],
                  conditions: [],
                  sorts: [],
                  limit: "",
                  flatten: "",
                  flattenAlias: "",
                  group: "",
                  groupAlias: "",
                  advancedClauses: [],
                  originalOperationTypes: [],
              };
    }

    private collectFields(): string[] {
        const fields = new Set(COMMON_FIELDS);

        for (const page of this.index.pages.values()) {
            for (const field of page.fields.keys()) fields.add(field);
        }

        return Array.from(fields).sort((a, b) => a.localeCompare(b));
    }

    public onOpen(): void {
        this.modalEl.addClass("dataview-query-builder-modal");
        this.titleEl.setText("Dataview query builder");
        this.contentEl.empty();

        const intro = this.contentEl.createDiv({ cls: "dataview-query-builder-intro" });
        intro.setText(
            this.block
                ? "Edit the Dataview query under your cursor. Existing syntax is preserved unless you change it."
                : "Build a standard Dataview query and insert it at the cursor."
        );

        this.bodyEl = this.contentEl.createDiv({ cls: "dataview-query-builder-body" });
        this.renderBody();

        const footer = this.contentEl.createDiv({ cls: "dataview-query-builder-footer" });
        const fields = footer.createEl("button", { text: "Manage inline fields" });
        fields.onclick = () => openFieldManager(this.app);

        const reset = footer.createEl("button", { text: "Reset" });
        reset.onclick = () => {
            const parsed = parseQuery(this.block?.source ?? "TABLE file.link");
            if (parsed.successful) this.draft = queryToDraft(parsed.value, this.fieldSuggestions);
            this.renderBody();
        };

        const apply = footer.createEl("button", {
            text: this.block ? "Apply changes" : "Insert query",
            cls: "mod-cta",
        });
        apply.onclick = () => this.apply();
    }

    private renderBody(): void {
        this.bodyEl.empty();

        new Setting(this.bodyEl)
            .setName("View")
            .setDesc("Choose the Dataview result type.")
            .addDropdown(dropdown => {
                dropdown.addOptions(VIEW_OPTIONS);
                dropdown.setValue(this.draft.type);
                dropdown.onChange(value => {
                    this.draft.type = value as QueryType;
                    this.renderBody();
                });
            });

        if (this.draft.type === "table" || this.draft.type === "list") {
            new Setting(this.bodyEl)
                .setName("Without ID")
                .setDesc("Hide the default file/link identifier.")
                .addToggle(toggle => {
                    toggle.setValue(this.draft.withoutId);
                    toggle.onChange(value => {
                        this.draft.withoutId = value;
                        this.updatePreview();
                    });
                });
        }

        if (this.draft.type === "table") this.renderTableFields();
        if (this.draft.type === "list") this.renderList();
        if (this.draft.type === "calendar") this.renderCalendar();

        this.renderSources();
        this.renderConditions();
        this.renderSorts();
        this.renderOtherOptions();
        this.renderPreview();
    }

    private renderTableFields(): void {
        const section = this.createSection(
            "Columns",
            "Select fields from the vault index or enter a custom expression."
        );

        this.draft.tableFields.forEach((field, index) => {
            const row = section.createDiv({ cls: "dataview-query-builder-row dataview-query-builder-row-wrap" });
            this.addFieldSelect(row, field.expression, value => {
                field.expression = value;
                this.updatePreview();
            });

            const alias = row.createEl("input", {
                type: "text",
                value: field.alias,
                placeholder: "Alias (optional)",
            });
            alias.oninput = () => {
                field.alias = alias.value;
                this.updatePreview();
            };

            this.addRemoveButton(row, () => {
                this.draft.tableFields.splice(index, 1);
                this.renderBody();
            });
        });

        const add = section.createEl("button", { text: "Add column" });
        add.onclick = () => {
            this.draft.tableFields.push({ expression: "file.name", alias: "" });
            this.renderBody();
        };
    }

    private renderList(): void {
        const section = this.createSection("List", "Optionally choose what each list item displays.");

        this.addFieldSelect(section, this.draft.listFormat, value => {
            this.draft.listFormat = value;
            this.updatePreview();
        }, "List expression");
    }

    private renderCalendar(): void {
        const section = this.createSection("Calendar", "Choose the date field used by the calendar.");

        this.addFieldSelect(section, this.draft.calendarField, value => {
            this.draft.calendarField = value;
            this.updatePreview();
        }, "Date field");
    }

    private renderSources(): void {
        const section = this.createSection("Source", "Combine folders, tags, links, CSV sources, and NOT with AND/OR.");

        this.draft.sources.forEach((source, index) => {
            const row = section.createDiv({ cls: "dataview-query-builder-row dataview-query-builder-row-wrap" });

            if (index > 0) {
                this.addDropdown(row, "Join", { AND: "AND", OR: "OR" }, source.join, value => {
                    source.join = value as LogicalJoin;
                    this.updatePreview();
                });
            }

            this.addDropdown(row, "Source type", SOURCE_OPTIONS, source.type, value => {
                source.type = value as SourceType;
                this.renderBody();
            });

            const value = row.createEl("input", {
                type: "text",
                value: source.value,
                placeholder: "Value / path / source expression",
            });
            value.oninput = () => {
                source.value = value.value;
                this.updatePreview();
            };

            this.addDropdown(
                row,
                "Negation",
                { false: "Normal", true: "NOT" },
                String(source.negate),
                value => {
                    source.negate = value === "true";
                    this.updatePreview();
                }
            );

            this.addRemoveButton(row, () => {
                this.draft.sources.splice(index, 1);
                if (this.draft.sources.length === 0) {
                    this.draft.sources.push({ type: "folder", value: "", join: "AND", negate: false });
                }
                this.renderBody();
            });
        });

        const add = section.createEl("button", { text: "Add source" });
        add.onclick = () => {
            this.draft.sources.push({ type: "folder", value: "", join: "AND", negate: false });
            this.renderBody();
        };
    }

    private renderConditions(): void {
        const section = this.createSection(
            "Conditions",
            "Build WHERE expressions with dropdown operators and AND / OR / NOT."
        );

        this.draft.conditions.forEach((condition, index) => {
            const row = section.createDiv({ cls: "dataview-query-builder-row dataview-query-builder-row-wrap" });

            if (index > 0) {
                this.addDropdown(row, "Join", { AND: "AND", OR: "OR" }, condition.join, value => {
                    condition.join = value as LogicalJoin;
                    this.updatePreview();
                });
            }

            this.addDropdown(
                row,
                "NOT",
                { false: "Normal", true: "NOT" },
                String(condition.negate),
                value => {
                    condition.negate = value === "true";
                    this.updatePreview();
                }
            );

            this.addFieldSelect(row, condition.field, value => {
                condition.field = value;
                this.updatePreview();
            });

            this.addDropdown(
                row,
                "Operator",
                Object.fromEntries(OPERATORS.map(operator => [operator, operator])),
                condition.operator,
                value => {
                    condition.operator = value as ConditionDraft["operator"];
                    this.updatePreview();
                }
            );

            const value = row.createEl("input", {
                type: "text",
                value: condition.value,
                placeholder: "Value / expression",
            });
            value.oninput = () => {
                condition.value = value.value;
                this.updatePreview();
            };

            this.addRemoveButton(row, () => {
                this.draft.conditions.splice(index, 1);
                this.renderBody();
            });
        });

        const add = section.createEl("button", { text: "Add condition" });
        add.onclick = () => {
            this.draft.conditions.push({
                field: "file.name",
                operator: "=",
                value: '""',
                join: "AND",
                negate: false,
            });
            this.renderBody();
        };
    }

    private renderSorts(): void {
        const section = this.createSection("Sort", "Choose one or more fields and sort direction.");

        this.draft.sorts.forEach((sort, index) => {
            const row = section.createDiv({ cls: "dataview-query-builder-row dataview-query-builder-row-wrap" });

            this.addFieldSelect(row, sort.field, value => {
                sort.field = value;
                this.updatePreview();
            });

            this.addDropdown(
                row,
                "Direction",
                { ascending: "Ascending", descending: "Descending" },
                sort.direction,
                value => {
                    sort.direction = value as SortDraft["direction"];
                    this.updatePreview();
                }
            );

            this.addRemoveButton(row, () => {
                this.draft.sorts.splice(index, 1);
                this.renderBody();
            });
        });

        const add = section.createEl("button", { text: "Add sort" });
        add.onclick = () => {
            this.draft.sorts.push({ field: "file.name", direction: "ascending" });
            this.renderBody();
        };
    }

    private renderOtherOptions(): void {
        const section = this.createSection(
            "Other query options",
            "Advanced Dataview clauses remain available when you need more control."
        );

        this.addFieldSelect(section, this.draft.flatten, value => {
            this.draft.flatten = value;
            this.updatePreview();
        }, "FLATTEN expression");

        this.addTextInput(section, "FLATTEN alias", this.draft.flattenAlias, value => {
            this.draft.flattenAlias = value;
            this.updatePreview();
        });

        this.addFieldSelect(section, this.draft.group, value => {
            this.draft.group = value;
            this.updatePreview();
        }, "GROUP BY expression");

        this.addTextInput(section, "GROUP BY alias", this.draft.groupAlias, value => {
            this.draft.groupAlias = value;
            this.updatePreview();
        });

        this.addTextInput(section, "LIMIT", this.draft.limit, value => {
            this.draft.limit = value;
            this.updatePreview();
        }, "Number or expression");

        const advanced = new Setting(section)
            .setName("Advanced clauses")
            .setDesc(
                "One existing Dataview clause per line. Use this for complex expressions you do not want to decompose."
            )
            .addTextArea(area => {
                area.inputEl.rows = 3;
                area.setValue(this.draft.advancedClauses.join("\n"));
                area.onChange(value => {
                    this.draft.advancedClauses = value
                        .split(/\r?\n/)
                        .map(line => line.trim())
                        .filter(Boolean);
                    this.updatePreview();
                });
            });

        void advanced;
    }

    private renderPreview(): void {
        const section = this.createSection(
            "Generated query",
            "This is standard Dataview syntax; the normal Dataview parser remains responsible for execution."
        );
        this.previewEl = section.createEl("pre", { cls: "dataview-query-builder-preview" });
        this.previewEl.setText(draftToText(this.draft));
    }

    private createSection(title: string, description: string): HTMLElement {
        const section = this.bodyEl.createDiv({ cls: "dataview-query-builder-section" });
        section.createEl("h3", { text: title });
        section.createDiv({ cls: "dataview-query-builder-description", text: description });
        return section;
    }

    private addDropdown(
        container: HTMLElement,
        label: string,
        options: Record<string, string>,
        value: string,
        onChange: (value: string) => void
    ): HTMLSelectElement {
        const wrapper = container.createDiv({ cls: "dataview-query-builder-control" });
        wrapper.createEl("label", { text: label });
        const select = wrapper.createEl("select");
        for (const [optionValue, labelText] of Object.entries(options)) {
            select.createEl("option", { value: optionValue, text: labelText });
        }
        setSelectValue(select, value);
        select.onchange = () => onChange(select.value);
        return select;
    }

    private addFieldSelect(
        container: HTMLElement,
        value: string,
        onChange: (value: string) => void,
        label = "Field / expression"
    ): void {
        const wrapper = container.createDiv({ cls: "dataview-query-builder-control" });
        wrapper.createEl("label", { text: label });
        const select = wrapper.createEl("select");

        for (const field of this.fieldSuggestions) {
            select.createEl("option", { value: field, text: field });
        }
        select.createEl("option", { value: "__custom__", text: "Custom expression…" });

        if (value && !this.fieldSuggestions.includes(value)) {
            select.value = "__custom__";
            const custom = wrapper.createEl("input", {
                type: "text",
                value,
                placeholder: "Dataview expression",
            });
            custom.oninput = () => onChange(custom.value);
        } else {
            select.value = value || this.fieldSuggestions[0] || "file.name";
        }

        select.onchange = () => {
            if (select.value === "__custom__") {
                const custom = wrapper.createEl("input", {
                    type: "text",
                    value: "",
                    placeholder: "Dataview expression",
                });
                custom.oninput = () => onChange(custom.value);
                custom.focus();
                return;
            }
            onChange(select.value);
        };
    }

    private addTextInput(
        container: HTMLElement,
        label: string,
        value: string,
        onChange: (value: string) => void,
        placeholder = ""
    ): void {
        const wrapper = container.createDiv({ cls: "dataview-query-builder-control" });
        wrapper.createEl("label", { text: label });
        const input = wrapper.createEl("input", { type: "text", value, placeholder });
        input.oninput = () => onChange(input.value);
    }

    private addRemoveButton(container: HTMLElement, onClick: () => void): void {
        const button = container.createEl("button", { text: "Remove" });
        button.onclick = onClick;
    }

    private updatePreview(): void {
        if (this.previewEl) this.previewEl.setText(draftToText(this.draft));
    }

    private apply(): void {
        const query = draftToText(this.draft).trim();
        if (!query) {
            new Notice("The query builder has no query to apply.");
            return;
        }

        const parsed = parseQuery(query);
        if (!parsed.successful) {
            new Notice(`Dataview builder generated invalid query: ${parsed.error}`);
            return;
        }

        if (!this.editor) {
            new Notice("Open a Markdown note before applying a Dataview query.");
            return;
        }

        if (this.block) {
            const lines = query.split("\n");
            this.editor.replaceRange(
                lines.join("\n"),
                { line: this.block.start + 1, ch: 0 },
                { line: this.block.end, ch: 0 }
            );
        } else {
            const cursor = this.editor.getCursor();
            const prefix = cursor.ch === 0 ? "" : "\n";
            const block = `${prefix}\`\`\`dataview\n${query}\n\`\`\`\n`;
            this.editor.replaceRange(block, cursor);
        }

        new Notice("Dataview query updated.");
        this.close();
    }

    public onClose(): void {
        this.contentEl.empty();
    }
}

export function openQueryBuilder(app: App, index: FullIndex): void {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
        new Notice("Open a Markdown note to use the Dataview query builder.");
        return;
    }

    const block = findDataviewBlock(view.editor);
    const initial = block?.source ?? "TABLE file.link";
    new QueryBuilderModal(app, index, initial, view.editor).open();
}
