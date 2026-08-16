import { App, Editor, MarkdownView, Modal, Notice } from "obsidian";
import { extractFullLineField, extractInlineFields, InlineField } from "data-import/inline-field";

type FieldEditKind = "inline" | "full-line";

interface FieldOccurrence {
    line: number;
    start: number;
    end: number;
    key: string;
    value: string;
    kind: FieldEditKind;
    wrapping?: string;
    original: string;
}

interface FieldEdit extends FieldOccurrence {
    newKey: string;
    newValue: string;
    deleted: boolean;
}

function getInlineReplacement(field: FieldEdit): string {
    if (field.deleted) return "";

    const value = field.newValue.trim();
    if (field.kind === "full-line") {
        const line = field.original;
        const separator = line.indexOf("::", field.start);
        const prefix = separator >= 0 ? line.substring(0, field.start) : "";
        return `${prefix}${field.newKey}::${value ? ` ${value}` : ""}`;
    }

    const wrapper = field.wrapping === "(" ? "(" : "[";
    const close = wrapper === "(" ? ")" : "]";
    return `${wrapper}${field.newKey}::${value ? ` ${value}` : ""}${close}`;
}

function findFullLineField(line: string): InlineField | undefined {
    return extractFullLineField(line);
}

function collectFields(source: string): FieldOccurrence[] {
    const lines = source.split("\n");
    const fields: FieldOccurrence[] = [];

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
        const line = lines[lineNumber];
        const inlineFields = extractInlineFields(line, false);

        for (const field of inlineFields) {
            fields.push({
                line: lineNumber,
                start: field.start,
                end: field.end,
                key: field.key,
                value: field.value,
                kind: "inline",
                wrapping: field.wrapping,
                original: line.substring(field.start, field.end),
            });
        }

        const full = findFullLineField(line);
        if (full && inlineFields.length === 0) {
            const separator = line.indexOf("::", 0);
            if (separator >= 0) {
                const keyStart = Math.max(0, line.lastIndexOf(full.key, separator));
                fields.push({
                    line: lineNumber,
                    start: keyStart,
                    end: line.length,
                    key: full.key,
                    value: full.value,
                    kind: "full-line",
                    original: line,
                });
            }
        }
    }

    return fields.sort((a, b) => a.line - b.line || a.start - b.start);
}

function applyEdits(editor: Editor, edits: FieldEdit[]): void {
    const byLine = new Map<number, FieldEdit[]>();

    for (const edit of edits) {
        const list = byLine.get(edit.line) ?? [];
        list.push(edit);
        byLine.set(edit.line, list);
    }

    for (const [lineNumber, lineEdits] of Array.from(byLine.entries()).sort((a, b) => b[0] - a[0])) {
        const line = editor.getLine(lineNumber);
        let replacement = line;

        const sorted = [...lineEdits].sort((a, b) => b.start - a.start || b.end - a.end);
        for (const edit of sorted) {
            const currentStart = edit.start;
            const currentEnd = edit.end;

            if (edit.kind === "full-line" && edit.deleted) {
                replacement = "";
                continue;
            }

            const before = replacement.substring(0, currentStart);
            const after = replacement.substring(currentEnd);
            const replacementText = getInlineReplacement(edit);
            replacement = `${before}${replacementText}${after}`;
        }

        const from = { line: lineNumber, ch: 0 };
        const to = { line: lineNumber, ch: line.length };
        editor.replaceRange(replacement, from, to);
    }

    new Notice("Dataview inline fields updated.");
}

class ConfirmFieldChangesModal extends Modal {
    constructor(
        app: App,
        private readonly edits: FieldEdit[],
        private readonly onConfirm: () => void
    ) {
        super(app);
    }

    onOpen(): void {
        this.titleEl.setText("Confirm inline field changes");
        this.contentEl.empty();

        const changes = this.contentEl.createDiv({ cls: "dataview-field-manager-confirm-list" });
        for (const edit of this.edits) {
            const row = changes.createDiv({ cls: "dataview-field-manager-confirm-row" });
            const location = row.createDiv({ cls: "dataview-field-manager-confirm-location" });
            location.setText(`Line ${edit.line + 1}`);

            const description = row.createDiv({ cls: "dataview-field-manager-confirm-change" });
            if (edit.deleted) {
                description.setText(`Delete ${edit.key} from this note`);
            } else if (edit.key !== edit.newKey) {
                description.setText(`Rename ${edit.key} → ${edit.newKey}`);
                if (edit.value !== edit.newValue) description.appendText(` and change its value`);
            } else if (edit.value !== edit.newValue) {
                description.setText(`Change ${edit.key} value`);
            }
        }

        const warning = this.contentEl.createDiv({ cls: "dataview-field-manager-confirm-warning" });
        warning.setText(
            "These changes will modify the current Markdown note. This cannot be undone by Dataview automatically."
        );

        const footer = this.contentEl.createDiv({ cls: "dataview-field-manager-footer" });
        const cancel = footer.createEl("button", { text: "Cancel" });
        cancel.onclick = () => this.close();

        const confirm = footer.createEl("button", { text: "Confirm changes", cls: "mod-warning" });
        confirm.onclick = () => {
            this.onConfirm();
            this.close();
        };
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export class FieldManagerModal extends Modal {
    private readonly editor: Editor;
    private edits: FieldEdit[];

    constructor(app: App, editor: Editor) {
        super(app);
        this.editor = editor;
        this.edits = collectFields(editor.getValue()).map(field => ({
            ...field,
            newKey: field.key,
            newValue: field.value,
            deleted: false,
        }));
    }

    onOpen(): void {
        this.modalEl.addClass("dataview-field-manager-modal");
        this.titleEl.setText("Dataview inline fields");
        this.render();
    }

    private render(): void {
        this.contentEl.empty();

        const intro = this.contentEl.createDiv({ cls: "dataview-field-manager-intro" });
        intro.setText(
            "Edit fields written with :: in the current note. Rename, change values, or mark fields for deletion. " +
                "Nothing is written until you confirm."
        );

        const path = this.app.workspace.getActiveFile()?.path;
        const meta = this.contentEl.createDiv({ cls: "dataview-field-manager-meta" });
        meta.setText(`${path ?? "Current note"} · ${this.edits.length} field${this.edits.length === 1 ? "" : "s"}`);

        const body = this.contentEl.createDiv({ cls: "dataview-field-manager-body" });

        if (this.edits.length === 0) {
            const empty = body.createDiv({ cls: "dataview-field-manager-empty" });
            empty.setText("No inline fields were found in this note.");
        } else {
            this.edits.forEach((edit, index) => this.renderEditRow(body, edit, index));
        }

        const footer = this.contentEl.createDiv({ cls: "dataview-field-manager-footer" });
        const refresh = footer.createEl("button", { text: "Reload fields" });
        refresh.onclick = () => {
            this.edits = collectFields(this.editor.getValue()).map(field => ({
                ...field,
                newKey: field.key,
                newValue: field.value,
                deleted: false,
            }));
            this.render();
        };

        const cancel = footer.createEl("button", { text: "Cancel" });
        cancel.onclick = () => this.close();

        const confirm = footer.createEl("button", { text: "Review & confirm", cls: "mod-cta" });
        confirm.disabled = !this.hasChanges();
        confirm.onclick = () => this.reviewChanges();
    }

    private renderEditRow(container: HTMLElement, edit: FieldEdit, index: number): void {
        const row = container.createDiv({ cls: "dataview-field-manager-row" });
        if (edit.deleted) row.addClass("is-deleted");

        const location = row.createDiv({ cls: "dataview-field-manager-location" });
        location.setText(`${index + 1} · line ${edit.line + 1}`);

        const key = row.createEl("input", {
            type: "text",
            value: edit.newKey,
            placeholder: "Field name",
            cls: "dataview-field-manager-key",
        });
        key.oninput = () => {
            edit.newKey = key.value.trim();
            row.toggleClass("has-invalid", edit.newKey.length === 0);
            this.updateConfirmButton();
        };

        const value = row.createEl("input", {
            type: "text",
            value: edit.newValue,
            placeholder: "Field value",
            cls: "dataview-field-manager-value",
        });
        value.oninput = () => {
            edit.newValue = value.value;
            this.updateConfirmButton();
        };

        const deleteButton = row.createEl("button", {
            text: edit.deleted ? "Keep" : "Delete",
            cls: edit.deleted ? "mod-cta" : "mod-warning",
        });
        deleteButton.onclick = () => {
            edit.deleted = !edit.deleted;
            row.toggleClass("is-deleted", edit.deleted);
            deleteButton.setText(edit.deleted ? "Keep" : "Delete");
            deleteButton.toggleClass("mod-warning", !edit.deleted);
            deleteButton.toggleClass("mod-cta", edit.deleted);
            this.updateConfirmButton();
        };
    }

    private updateConfirmButton(): void {
        const buttons = this.contentEl.querySelectorAll<HTMLButtonElement>(
            ".dataview-field-manager-footer button.mod-cta"
        );
        if (buttons.length > 0) buttons[buttons.length - 1].disabled = !this.hasChanges();
    }

    private hasChanges(): boolean {
        return this.edits.some(edit => edit.deleted || edit.key !== edit.newKey || edit.value !== edit.newValue);
    }

    private reviewChanges(): void {
        const changes = this.edits.filter(
            edit => edit.deleted || edit.key !== edit.newKey || edit.value !== edit.newValue
        );

        if (changes.some(edit => edit.newKey.trim().length === 0 && !edit.deleted)) {
            new Notice("Field names cannot be empty.");
            return;
        }

        new ConfirmFieldChangesModal(this.app, changes, () => {
            applyEdits(this.editor, changes);
            new Notice(`Applied ${changes.length} inline field change${changes.length === 1 ? "" : "s"}.`);
            this.close();
        }).open();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

export function openFieldManager(app: App): void {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
        new Notice("Open a Markdown note to edit Dataview inline fields.");
        return;
    }

    new FieldManagerModal(app, view.editor).open();
}
