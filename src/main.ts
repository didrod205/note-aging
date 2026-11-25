import { App, ItemView, Menu, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
	AgingSettings, Bucket, BUCKETS, DEFAULT_SETTINGS, NoteAge, cleanThresholds, computeAge, countByBucket,
	isExcluded, longAge, shortAge, sortOldestFirst, todayString, weightedPick,
} from "./core";

export const VIEW_TYPE = "note-aging-view";

const BUCKET_LABEL: Record<Bucket, string> = { fresh: "Fresh", aging: "Aging", old: "Old", stale: "Stale" };

export default class NoteAgingPlugin extends Plugin {
	settings: AgingSettings = { ...DEFAULT_SETTINGS };
	private statusEl: HTMLElement | null = null;
	private observers: MutationObserver[] = [];
	private refreshTimer: number | null = null;
	private decorateTimer: number | null = null;
	private cache: Map<string, NoteAge> | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new AgingView(leaf, this));

		this.addRibbonIcon("hourglass", "Open aging notes", () => {
			void this.openView();
		});

		this.addCommand({ id: "open-view", name: "Open aging notes", callback: () => void this.openView() });
		this.addCommand({
			id: "mark-reviewed",
			name: "Mark current note as reviewed",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "md") return false;
				if (!checking) void this.markReviewed([f]);
				return true;
			},
		});
		this.addCommand({ id: "random-old-note", name: "Open a random old note", callback: () => void this.openRandom() });

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((i) => i.setTitle("Mark as reviewed").setIcon("check").onClick(() => void this.markReviewed([file])));
			}),
		);
		this.registerEvent(
			this.app.workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
				const md = files.filter((f): f is TFile => f instanceof TFile && f.extension === "md");
				if (!md.length) return;
				menu.addItem((i) => i.setTitle(`Mark ${md.length} notes as reviewed`).setIcon("check").onClick(() => void this.markReviewed(md)));
			}),
		);

		const dirty = () => this.scheduleRefresh();
		this.registerEvent(this.app.vault.on("modify", dirty));
		this.registerEvent(this.app.vault.on("create", dirty));
		this.registerEvent(this.app.vault.on("delete", dirty));
		this.registerEvent(this.app.vault.on("rename", dirty));
		this.registerEvent(this.app.metadataCache.on("changed", dirty));
		this.registerEvent(this.app.workspace.on("file-open", () => this.updateStatusBar()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.attachExplorers()));

		this.addSettingTab(new AgingSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.applyBodyClasses();
			this.setupStatusBar();
			this.attachExplorers();
			// refresh once a day-ish so labels roll over without a restart
			this.registerInterval(window.setInterval(() => this.scheduleRefresh(), 60 * 60 * 1000));
		});
	}

	onunload() {
		for (const o of this.observers) o.disconnect();
		this.observers = [];
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.decorateTimer !== null) window.clearTimeout(this.decorateTimer);
		document.body.removeClass("note-aging-fade", "note-aging-dot");
		document.querySelectorAll<HTMLElement>(".nav-file-title[data-note-age]").forEach((el) => el.removeAttribute("data-note-age"));
		document.querySelectorAll(".note-aging-badge").forEach((el) => el.remove());
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<AgingSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
		this.settings.thresholds = cleanThresholds(this.settings.thresholds ?? DEFAULT_SETTINGS.thresholds);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.cache = null;
		this.applyBodyClasses();
		this.refreshNow();
	}

	// ---------- ages ----------

	ageOf(file: TFile, now = Date.now()): NoteAge {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		return computeAge(
			{ path: file.path, mtime: file.stat.mtime, ctime: file.stat.ctime, propertyValue: fm?.[this.settings.property] },
			this.settings,
			now,
		);
	}

	/** All tracked notes (markdown, not excluded). Cached until something changes. */
	allAges(): NoteAge[] {
		if (!this.cache) {
			const now = Date.now();
			const m = new Map<string, NoteAge>();
			for (const f of this.app.vault.getMarkdownFiles()) {
				if (isExcluded(f.path, this.settings.excludeFolders)) continue;
				m.set(f.path, this.ageOf(f, now));
			}
			this.cache = m;
		}
		return [...this.cache.values()];
	}

	private ageForPath(path: string): NoteAge | undefined {
		if (!this.cache) this.allAges();
		return this.cache?.get(path);
	}

	// ---------- actions ----------

	async markReviewed(files: TFile[]) {
		const today = todayString(Date.now());
		let n = 0;
		for (const f of files) {
			try {
				await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
					fm[this.settings.property] = today;
				});
				n++;
			} catch (e) {
				console.error("Note Aging: could not update", f.path, e);
			}
		}
		new Notice(n === 1 ? `Marked "${files[0].basename}" as reviewed` : `Marked ${n} notes as reviewed`);
		this.cache = null;
		this.scheduleRefresh();
	}

	async openRandom() {
		const pick = weightedPick(this.allAges(), this.settings.randomMinDays, this.settings.randomWeight);
		if (!pick) {
			new Notice(`No notes older than ${this.settings.randomMinDays} days. Nice gardening.`);
			return;
		}
		const f = this.app.vault.getFileByPath(pick.path);
		if (f) {
			await this.app.workspace.getLeaf(false).openFile(f);
			new Notice(`Last touched ${longAge(pick.days)}`);
		}
	}

	async openView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			leaf = right;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	// ---------- refresh plumbing ----------

	scheduleRefresh() {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refreshNow();
		}, 400);
	}

	refreshNow() {
		this.cache = null;
		this.decorateAll();
		this.updateStatusBar();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const v = leaf.view;
			if (v instanceof AgingView) v.render();
		}
	}

	applyBodyClasses() {
		document.body.toggleClass("note-aging-fade", this.settings.explorerStyle === "fade");
		document.body.toggleClass("note-aging-dot", this.settings.explorerStyle === "dot");
	}

	private attachExplorers() {
		for (const o of this.observers) o.disconnect();
		this.observers = [];
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const el = leaf.view.containerEl;
			// the explorer renders rows lazily, so re-decorate whenever rows are added
			const obs = new MutationObserver(() => this.scheduleDecorate());
			obs.observe(el, { childList: true, subtree: true });
			this.observers.push(obs);
		}
		this.decorateAll();
	}

	private scheduleDecorate() {
		if (this.decorateTimer !== null) return;
		this.decorateTimer = window.setTimeout(() => {
			this.decorateTimer = null;
			this.decorateAll();
		}, 150);
	}

	decorateAll() {
		const off = this.settings.explorerStyle === "off" && !this.settings.showBadge;
		const rows = document.querySelectorAll<HTMLElement>(".nav-file-title[data-path]");
		rows.forEach((row) => {
			const path = row.getAttribute("data-path") ?? "";
			const age = off || !path.endsWith(".md") ? undefined : this.ageForPath(path);
			if (!age) {
				if (row.hasAttribute("data-note-age")) row.removeAttribute("data-note-age");
				row.querySelector(".note-aging-badge")?.remove();
				return;
			}
			if (row.getAttribute("data-note-age") !== age.bucket) row.setAttribute("data-note-age", age.bucket);
			let badge = row.querySelector<HTMLElement>(".note-aging-badge");
			if (this.settings.showBadge) {
				const label = shortAge(age.days);
				if (!badge) badge = row.createSpan({ cls: "note-aging-badge" });
				if (badge.textContent !== label) badge.setText(label);
				badge.setAttr("aria-label", `${sourceWord(age)} ${longAge(age.days)}`);
			} else if (badge) {
				badge.remove();
			}
		});
	}

	private setupStatusBar() {
		this.statusEl?.remove();
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("note-aging-status", "mod-clickable");
		this.statusEl.addEventListener("click", () => {
			const f = this.app.workspace.getActiveFile();
			if (f && f.extension === "md") void this.markReviewed([f]);
		});
		this.updateStatusBar();
	}

	updateStatusBar() {
		const el = this.statusEl;
		if (!el) return;
		const f = this.app.workspace.getActiveFile();
		if (!this.settings.showStatusBar || !f || f.extension !== "md" || isExcluded(f.path, this.settings.excludeFolders)) {
			el.hide();
			return;
		}
		const age = this.ageOf(f);
		el.show();
		el.empty();
		el.createSpan({ cls: `note-aging-dot-inline is-${age.bucket}` });
		el.createSpan({ text: `${sourceWord(age)} ${longAge(age.days)}` });
		el.setAttr("aria-label", "Click to mark as reviewed");
	}
}

function sourceWord(a: NoteAge): string {
	return a.from === "property" ? "Reviewed" : a.from === "created" ? "Created" : "Edited";
}

// ---------------------------------------------------------------------------

class AgingView extends ItemView {
	private filter = "";
	private bucket: Bucket | "all" = "all";
	private limit = 100;

	constructor(leaf: WorkspaceLeaf, private plugin: NoteAgingPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "Aging notes";
	}
	getIcon() {
		return "hourglass";
	}

	async onOpen() {
		this.render();
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("note-aging-view");

		const ages = this.plugin.allAges();
		const counts = countByBucket(ages);
		const total = ages.length;

		const head = root.createDiv({ cls: "note-aging-head" });
		head.createDiv({ cls: "note-aging-title", text: `${total} notes` });

		const bar = head.createDiv({ cls: "note-aging-bar" });
		for (const b of BUCKETS) {
			if (!counts[b]) continue;
			const seg = bar.createDiv({ cls: `note-aging-seg is-${b}` });
			seg.style.flexGrow = String(counts[b]);
			seg.setAttr("aria-label", `${BUCKET_LABEL[b]}: ${counts[b]}`);
		}

		const chips = head.createDiv({ cls: "note-aging-chips" });
		const mkChip = (key: Bucket | "all", label: string, n: number) => {
			const c = chips.createEl("button", { cls: "note-aging-chip" });
			if (key !== "all") c.createSpan({ cls: `note-aging-dot-inline is-${key}` });
			c.createSpan({ text: `${label} ${n}` });
			if (this.bucket === key) c.addClass("is-active");
			c.addEventListener("click", () => {
				this.bucket = key;
				this.limit = 100;
				this.render();
			});
		};
		mkChip("all", "All", total);
		for (const b of BUCKETS) mkChip(b, BUCKET_LABEL[b], counts[b]);

		const tools = head.createDiv({ cls: "note-aging-tools" });
		const input = tools.createEl("input", { type: "search", placeholder: "Filter by name or folder", value: this.filter });
		input.addClass("note-aging-filter");
		input.addEventListener("input", () => {
			this.filter = input.value;
			this.limit = 100;
			this.renderList(listEl, ages);
		});
		const rnd = tools.createEl("button", { cls: "note-aging-random", attr: { "aria-label": "Open a random old note" } });
		setIcon(rnd, "dices");
		rnd.addEventListener("click", () => void this.plugin.openRandom());

		const listEl = root.createDiv({ cls: "note-aging-list" });
		this.renderList(listEl, ages);
	}

	private renderList(listEl: HTMLElement, ages: NoteAge[]) {
		listEl.empty();
		const q = this.filter.trim().toLowerCase();
		const rows = sortOldestFirst(ages).filter(
			(a) => (this.bucket === "all" || a.bucket === this.bucket) && (!q || a.path.toLowerCase().includes(q)),
		);
		if (!rows.length) {
			listEl.createDiv({ cls: "note-aging-empty", text: q ? "No notes match this filter." : "Nothing here." });
			return;
		}
		for (const a of rows.slice(0, this.limit)) {
			const row = listEl.createDiv({ cls: "note-aging-row" });
			row.createSpan({ cls: `note-aging-dot-inline is-${a.bucket}` });
			const main = row.createDiv({ cls: "note-aging-main" });
			const slash = a.path.lastIndexOf("/");
			const name = a.path.slice(slash + 1).replace(/\.md$/, "");
			main.createDiv({ cls: "note-aging-name", text: name });
			if (slash > 0) main.createDiv({ cls: "note-aging-folder", text: a.path.slice(0, slash) });
			const age = row.createDiv({ cls: "note-aging-age", text: shortAge(a.days) });
			age.setAttr("aria-label", `${sourceWord(a)} ${longAge(a.days)}`);
			const btn = row.createEl("button", { cls: "note-aging-check clickable-icon", attr: { "aria-label": "Mark as reviewed" } });
			setIcon(btn, "check");
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const f = this.app.vault.getFileByPath(a.path);
				if (f) void this.plugin.markReviewed([f]);
			});
			row.addEventListener("click", (e) => {
				const f = this.app.vault.getFileByPath(a.path);
				if (f) void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey).openFile(f);
			});
		}
		if (rows.length > this.limit) {
			const more = listEl.createEl("button", { cls: "note-aging-more", text: `Show ${Math.min(100, rows.length - this.limit)} more (${rows.length - this.limit} left)` });
			more.addEventListener("click", () => {
				this.limit += 100;
				this.renderList(listEl, ages);
			});
		}
	}
}

// ---------------------------------------------------------------------------

class AgingSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: NoteAgingPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Measure age from")
			.setDesc("Review property falls back to the last edit time for notes that have never been reviewed. Sync tools can touch edit times, so the property is the most reliable choice.")
			.addDropdown((d) =>
				d
					.addOption("property", "Review property")
					.addOption("modified", "Last edit time")
					.addOption("created", "Creation time")
					.setValue(s.source)
					.onChange((v) => {
						s.source = v as AgingSettings["source"];
						save();
					}),
			);

		new Setting(containerEl)
			.setName("Review property")
			.setDesc("Frontmatter key that stores the review date. \"Mark as reviewed\" writes today's date here.")
			.addText((t) =>
				t.setValue(s.property).onChange((v) => {
					s.property = v.trim() || "reviewed";
					save();
				}),
			);

		new Setting(containerEl).setName("Age groups").setHeading();
		const names = ["Fresh until (days)", "Aging until (days)", "Old until (days)"];
		const descs = ["Younger notes count as fresh.", "Then aging until this age.", "Older notes count as stale."];
		names.forEach((name, i) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(descs[i])
				.addText((t) => {
					t.inputEl.type = "number";
					t.setValue(String(s.thresholds[i])).onChange((v) => {
						const next = [...s.thresholds];
						next[i] = Number(v);
						s.thresholds = cleanThresholds(next);
						save();
					});
				});
		});

		new Setting(containerEl).setName("Display").setHeading();
		new Setting(containerEl)
			.setName("File explorer style")
			.setDesc("Fade older notes, or show a small coloured dot.")
			.addDropdown((d) =>
				d
					.addOption("fade", "Fade")
					.addOption("dot", "Coloured dot")
					.addOption("off", "Off")
					.setValue(s.explorerStyle)
					.onChange((v) => {
						s.explorerStyle = v as AgingSettings["explorerStyle"];
						save();
					}),
			);
		new Setting(containerEl)
			.setName("Show age in file explorer")
			.setDesc("Adds a short label such as 3mo next to each note.")
			.addToggle((t) =>
				t.setValue(s.showBadge).onChange((v) => {
					s.showBadge = v;
					save();
				}),
			);
		new Setting(containerEl)
			.setName("Show age in status bar")
			.setDesc("Click it to mark the open note as reviewed.")
			.addToggle((t) =>
				t.setValue(s.showStatusBar).onChange((v) => {
					s.showStatusBar = v;
					save();
				}),
			);

		new Setting(containerEl).setName("Scope").setHeading();
		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder per line, for example your daily notes or templates.")
			.addTextArea((t) => {
				t.setPlaceholder("Daily\nTemplates")
					.setValue(s.excludeFolders.join("\n"))
					.onChange((v) => {
						s.excludeFolders = v.split("\n").map((x) => x.trim()).filter(Boolean);
						save();
					});
				t.inputEl.rows = 4;
			});

		new Setting(containerEl).setName("Random old note").setHeading();
		new Setting(containerEl)
			.setName("Minimum age (days)")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(s.randomMinDays)).onChange((v) => {
					s.randomMinDays = Math.max(0, Math.round(Number(v) || 0));
					save();
				});
			});
		new Setting(containerEl)
			.setName("Favour older notes")
			.setDesc("1 picks evenly. 3 makes the oldest note three times as likely as the youngest eligible one.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 10, 1)
					.setValue(s.randomWeight)
					.setDynamicTooltip()
					.onChange((v) => {
						s.randomWeight = v;
						save();
					}),
			);
	}
}
