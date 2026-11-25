// Minimal browser shim of the Obsidian API, used only for local UI screenshots.
import { createElement, Hourglass, Dices, Check } from "lucide";

type DomInfo = { cls?: string | string[]; text?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string };
function applyInfo(el: HTMLElement, o?: DomInfo) {
	if (!o) return;
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	if (o.type) (el as HTMLInputElement).type = o.type;
	if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
	if (o.placeholder) (el as HTMLInputElement).placeholder = o.placeholder;
}
const P = HTMLElement.prototype as any;
P.createEl = function (tag: string, o?: DomInfo) { const el = document.createElement(tag); applyInfo(el, o); this.appendChild(el); return el; };
P.createDiv = function (o?: DomInfo) { return this.createEl("div", o); };
P.createSpan = function (o?: DomInfo) { return this.createEl("span", o); };
P.empty = function () { this.innerHTML = ""; };
P.setText = function (t: string) { this.textContent = t; };
P.addClass = function (...c: string[]) { this.classList.add(...c); };
P.removeClass = function (...c: string[]) { this.classList.remove(...c); };
P.toggleClass = function (c: string, v: boolean) { this.classList.toggle(c, v); };
P.setAttr = function (k: string, v: string) { this.setAttribute(k, v); };
P.hide = function () { this.style.display = "none"; };
P.show = function () { this.style.display = ""; };

const ICONS: Record<string, any> = { hourglass: Hourglass, dices: Dices, check: Check };
export function setIcon(el: HTMLElement, name: string) {
	el.innerHTML = "";
	const node = ICONS[name];
	if (node) { const svg = createElement(node); svg.setAttribute("class", "svg-icon"); el.appendChild(svg); }
}

export class Notice {
	constructor(msg: string) {
		let c = document.querySelector(".notice-container") as HTMLElement | null;
		if (!c) c = (document.body as any).createDiv({ cls: "notice-container" });
		const n = (c as any).createDiv({ cls: "notice", text: msg });
		(window as any).__notices = [...((window as any).__notices ?? []), msg];
		setTimeout(() => n.remove(), 4000);
	}
}

export class TAbstractFile { constructor(public path: string) {} get name() { return this.path.split("/").pop()!; } }
export class TFile extends TAbstractFile {
	extension = "md";
	stat = { mtime: 0, ctime: 0, size: 0 };
	get basename() { return this.name.replace(/\.md$/, ""); }
}
export class Menu {}

type Listener = (...a: any[]) => void;
class Events {
	private l = new Map<string, Listener[]>();
	on(n: string, fn: Listener) { this.l.set(n, [...(this.l.get(n) ?? []), fn]); return { n, fn }; }
	trigger(n: string, ...a: any[]) { (this.l.get(n) ?? []).forEach((f) => f(...a)); }
}

export interface FakeNote { path: string; mtime: number; ctime: number; fm?: Record<string, unknown> }

export class Vault extends Events {
	fileObjs = new Map<string, TFile>();
	fm = new Map<string, Record<string, unknown>>();
	constructor(notes: FakeNote[]) {
		super();
		for (const n of notes) {
			const f = new TFile(n.path);
			f.stat = { mtime: n.mtime, ctime: n.ctime, size: 100 };
			this.fileObjs.set(n.path, f);
			if (n.fm) this.fm.set(n.path, n.fm);
		}
	}
	getMarkdownFiles() { return [...this.fileObjs.values()]; }
	getFileByPath(p: string) { return this.fileObjs.get(p) ?? null; }
}

export class MetadataCache extends Events {
	constructor(private app: App) { super(); }
	getFileCache(f: TFile) { return { frontmatter: this.app.vault.fm.get(f.path) }; }
}

export class FileManager {
	constructor(private app: App) {}
	async processFrontMatter(f: TFile, fn: (fm: any) => void) {
		const fm = { ...(this.app.vault.fm.get(f.path) ?? {}) };
		fn(fm);
		this.app.vault.fm.set(f.path, fm);
		f.stat.mtime = Date.now();
		this.app.vault.trigger("modify", f);
		this.app.metadataCache.trigger("changed", f);
	}
}

export class WorkspaceLeaf {
	view: any = null;
	constructor(public app: App, public container: HTMLElement) {}
	async setViewState(s: { type: string }) {
		const ctor = this.app.workspace.viewCreators.get(s.type)!;
		this.view = ctor(this);
		this.container.innerHTML = "";
		this.container.appendChild(this.view.containerEl);
		await this.view.onOpen();
	}
	async openFile(f: TFile) { this.app.workspace.active = f; this.app.workspace.trigger("file-open", f); }
}

export class Workspace extends Events {
	viewCreators = new Map<string, (l: WorkspaceLeaf) => any>();
	leaves: WorkspaceLeaf[] = [];
	active: TFile | null = null;
	constructor(private app: App, private right: HTMLElement, explorerEl: HTMLElement) {
		super();
		const l = new WorkspaceLeaf(app, explorerEl);
		l.view = { getViewType: () => "file-explorer", containerEl: explorerEl };
		this.leaves.push(l);
	}
	getLeavesOfType(t: string) { return this.leaves.filter((l) => l.view?.getViewType() === t); }
	getRightLeaf() { const l = new WorkspaceLeaf(this.app, this.right); this.leaves.push(l); return l; }
	getLeaf() { return { openFile: async (f: TFile) => { this.active = f; this.trigger("file-open", f); } }; }
	async revealLeaf() {}
	getActiveFile() { return this.active; }
	onLayoutReady(fn: () => void) { setTimeout(fn, 0); }
}

export class App {
	vault: Vault; metadataCache: MetadataCache; workspace: Workspace; fileManager: FileManager;
	constructor(notes: FakeNote[], right: HTMLElement, explorer: HTMLElement) {
		this.vault = new Vault(notes);
		this.metadataCache = new MetadataCache(this);
		this.workspace = new Workspace(this, right, explorer);
		this.fileManager = new FileManager(this);
	}
}

export class Component { registerEvent() {} register() {} registerInterval() { return 0; } }

export class ItemView extends Component {
	containerEl: HTMLElement; contentEl: HTMLElement; app: App;
	constructor(public leaf: WorkspaceLeaf) {
		super();
		this.app = leaf.app;
		this.containerEl = document.createElement("div");
		this.containerEl.className = "workspace-leaf-content";
		const h = (this.containerEl as any).createDiv({ cls: "view-header" });
		h.createDiv({ cls: "view-header-title", text: "Aging notes" });
		this.contentEl = (this.containerEl as any).createDiv({ cls: "view-content" });
	}
	async onOpen() {}
}

class Comp { constructor(public el: HTMLElement) {} }
class TextComponent extends Comp {
	inputEl: HTMLInputElement;
	constructor(p: HTMLElement, tag = "input") { super(p); this.inputEl = (p as any).createEl(tag, tag === "input" ? { type: "text" } : {}); }
	setValue(v: string) { this.inputEl.value = v; return this; }
	setPlaceholder(v: string) { this.inputEl.placeholder = v; return this; }
	onChange(fn: (v: string) => any) { this.inputEl.addEventListener("input", () => fn(this.inputEl.value)); return this; }
}
class ToggleComponent extends Comp {
	toggleEl: HTMLElement; private v = false; private fn?: (v: boolean) => any;
	constructor(p: HTMLElement) { super(p); this.toggleEl = (p as any).createDiv({ cls: "checkbox-container" }); this.toggleEl.createEl("input", { type: "checkbox" } as any); this.toggleEl.onclick = () => this.setValue(!this.v, true); }
	setValue(v: boolean, fire = false) { this.v = v; this.toggleEl.classList.toggle("is-enabled", v); if (fire) this.fn?.(v); return this; }
	onChange(fn: (v: boolean) => any) { this.fn = fn; return this; }
}
class DropdownComponent extends Comp {
	selectEl: HTMLSelectElement;
	constructor(p: HTMLElement) { super(p); this.selectEl = (p as any).createEl("select", { cls: "dropdown" }); }
	addOption(v: string, t: string) { const o = document.createElement("option"); o.value = v; o.textContent = t; this.selectEl.appendChild(o); return this; }
	setValue(v: string) { this.selectEl.value = v; return this; }
	onChange(fn: (v: string) => any) { this.selectEl.addEventListener("change", () => fn(this.selectEl.value)); return this; }
}
class SliderComponent extends Comp {
	sliderEl: HTMLInputElement;
	constructor(p: HTMLElement) { super(p); this.sliderEl = (p as any).createEl("input", { type: "range", cls: "slider" }); }
	setLimits(a: number, b: number, s: number) { this.sliderEl.min = String(a); this.sliderEl.max = String(b); this.sliderEl.step = String(s); return this; }
	setValue(v: number) { this.sliderEl.value = String(v); return this; }
	setDynamicTooltip() { return this; }
	onChange(fn: (v: number) => any) { this.sliderEl.addEventListener("input", () => fn(Number(this.sliderEl.value))); return this; }
}

export class Setting {
	settingEl: HTMLElement; private nameEl: HTMLElement; private descEl: HTMLElement; private controlEl: HTMLElement;
	constructor(parent: HTMLElement) {
		this.settingEl = (parent as any).createDiv({ cls: "setting-item" });
		const info = (this.settingEl as any).createDiv({ cls: "setting-item-info" });
		this.nameEl = info.createDiv({ cls: "setting-item-name" });
		this.descEl = info.createDiv({ cls: "setting-item-description" });
		this.controlEl = (this.settingEl as any).createDiv({ cls: "setting-item-control" });
	}
	setName(n: string) { this.nameEl.textContent = n; return this; }
	setDesc(d: string) { this.descEl.textContent = d; return this; }
	setHeading() { this.settingEl.classList.add("setting-item-heading"); return this; }
	addText(cb: (t: TextComponent) => any) { cb(new TextComponent(this.controlEl)); return this; }
	addTextArea(cb: (t: TextComponent) => any) { cb(new TextComponent(this.controlEl, "textarea")); return this; }
	addToggle(cb: (t: ToggleComponent) => any) { cb(new ToggleComponent(this.controlEl)); return this; }
	addDropdown(cb: (t: DropdownComponent) => any) { cb(new DropdownComponent(this.controlEl)); return this; }
	addSlider(cb: (t: SliderComponent) => any) { cb(new SliderComponent(this.controlEl)); return this; }
}

export class Plugin extends Component {
	app: App; manifest: any; private data: any = null;
	constructor(app: App, manifest: any) { super(); this.app = app; this.manifest = manifest; }
	registerView(t: string, fn: (l: WorkspaceLeaf) => any) { this.app.workspace.viewCreators.set(t, fn); }
	addRibbonIcon() {}
	addCommand(c: { id: string; callback?: () => any; checkCallback?: (c: boolean) => any }) { ((window as any).__commands ??= {})[c.id] = c.callback ?? (() => c.checkCallback!(false)); }
	addSettingTab(t: any) { (window as any).__settingTab = t; }
	addStatusBarItem() { return (document.getElementById("statusbar") as any).createDiv({ cls: "status-bar-item" }); }
	async loadData() { return this.data; }
	async saveData(d: any) { this.data = JSON.parse(JSON.stringify(d)); }
}

export class PluginSettingTab {
	containerEl: HTMLElement;
	constructor(public app: App, public plugin: Plugin) { this.containerEl = document.createElement("div"); this.containerEl.className = "vertical-tab-content"; }
}
