import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import { type Component, PiGuiComponentKind } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

export type SettingsListSnapshotItem = Omit<SettingItem, "submenu">;

export interface SettingsListSnapshot {
	items: SettingsListSnapshotItem[];
	selectedIndex: number;
	maxVisible: number;
	searchEnabled: boolean;
	focused: boolean;
	visibleStart: number;
	visibleEnd: number;
	noMatch: boolean;
	filter?: string;
	submenu?: Component;
}

export function isValidSettingsIndex(index: number): boolean {
	return Number.isFinite(index) && Number.isInteger(index);
}

export class SettingsList implements Component {
	readonly [PiGuiComponentKind]: PiGuiComponentKind = "settingslist";
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;
	private focused = false;

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private submenuSession: object | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	getSnapshot(): SettingsListSnapshot {
		const filter = this.searchInput?.getValue();
		const displayItems = this.getDisplayItems();
		const { start, end } = this.getVisibleRange(displayItems);
		return {
			items: displayItems.map((item) => ({
				id: item.id,
				label: item.label,
				description: item.description,
				currentValue: item.currentValue,
				values: item.values ? [...item.values] : undefined,
			})),
			selectedIndex: this.selectedIndex,
			maxVisible: this.maxVisible,
			searchEnabled: this.searchEnabled,
			focused: this.focused,
			visibleStart: start,
			visibleEnd: end,
			noMatch: displayItems.length === 0,
			filter: filter || undefined,
			submenu: this.submenuComponent ?? undefined,
		};
	}

	setFocused(focused: boolean): boolean {
		if (typeof focused !== "boolean") return false;
		this.focused = focused;
		this.searchInput?.setFocused(focused);
		return true;
	}

	setFilter(filter: string): boolean {
		if (typeof filter !== "string" || !this.searchEnabled || !this.searchInput) return false;
		this.searchInput.setValue(filter);
		this.applyFilter(filter);
		return true;
	}

	getChildren(): readonly Component[] {
		return this.submenuComponent ? [this.submenuComponent] : [];
	}

	activateIndex(index: number): boolean {
		const displayItems = this.getDisplayItems();
		if (!isValidSettingsIndex(index) || index < 0 || index >= displayItems.length) return false;
		this.selectedIndex = index;
		return this.activateItem();
	}

	setSelectedIndex(index: number): boolean {
		if (!isValidSettingsIndex(index)) return false;
		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) {
			this.selectedIndex = 0;
			return true;
		}
		this.selectedIndex = Math.max(0, Math.min(index, displayItems.length - 1));
		return true;
	}

	getSelectedItem(): SettingItem | undefined {
		const displayItems = this.getDisplayItems();
		return displayItems[this.selectedIndex];
	}

	setItemValue(id: string, newValue: string): boolean {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) return false;
		if (item.values && !item.values.includes(newValue)) return false;
		item.currentValue = newValue;
		this.onChange(item.id, newValue);
		return true;
	}

	activateSelected(): boolean {
		return this.activateItem();
	}

	cycleSelected(direction: 1 | -1): boolean {
		if (direction !== 1 && direction !== -1) return false;
		const item = this.getSelectedItem();
		if (!item?.values?.length) return false;

		const currentIndex = item.values.indexOf(item.currentValue);
		const nextIndex =
			currentIndex < 0
				? direction === 1
					? 0
					: item.values.length - 1
				: (currentIndex + direction + item.values.length) % item.values.length;
		const newValue = item.values[nextIndex];
		if (newValue == null) return false;
		item.currentValue = newValue;
		this.onChange(item.id, newValue);
		return true;
	}

	cancel(): void {
		this.onCancel();
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Calculate visible range with scrolling
		const { start: startIndex, end: endIndex } = this.getVisibleRange(displayItems);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		const displayItems = this.getDisplayItems();
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(data, "tui.select.confirm") || data === " ") {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			const sanitized = data.replace(/ /g, "");
			if (!sanitized) {
				return;
			}
			this.searchInput.handleInput(sanitized);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private activateItem(): boolean {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return false;

		if (item.submenu) {
			this.submenuItemIndex = this.selectedIndex;
			const session = {};
			this.submenuSession = session;
			let constructing = true;
			let settled = false;
			let completionValue: string | undefined;
			const submenu = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (settled) return;
				settled = true;
				completionValue = selectedValue;
				if (!constructing) this.completeSubmenu(session, item, selectedValue);
			});
			constructing = false;
			if (!settled) {
				this.submenuComponent = submenu;
			} else {
				this.safeDispose(submenu);
				this.completeSubmenu(session, item, completionValue);
			}
		} else if (item.values && item.values.length > 0) {
			return this.cycleSelected(1);
		} else {
			return false;
		}
		return true;
	}

	private completeSubmenu(session: object, item: SettingItem, selectedValue?: string): void {
		if (this.submenuSession !== session) return;
		if (selectedValue !== undefined) item.currentValue = selectedValue;
		this.submenuComponent = null;
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
		this.submenuSession = null;
		if (selectedValue !== undefined) this.onChange(item.id, selectedValue);
	}

	private safeDispose(component: Component): void {
		try {
			component.dispose?.();
		} catch {
			// Disposal must not break completion or callback delivery.
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private getDisplayItems(): SettingItem[] {
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	private getVisibleRange(displayItems: SettingItem[]): { start: number; end: number } {
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		return { start, end: Math.min(start + this.maxVisible, displayItems.length) };
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
