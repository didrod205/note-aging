import { App, FakeNote } from "obsidian";
import Plugin from "../src/main";

const DAY = 86400000;
const now = Date.now();
const d = (n: number) => now - n * DAY;
const iso = (n: number) => new Date(d(n)).toISOString().slice(0, 10);
// [path, days since last edit, reviewed days ago (optional)]
const spec: [string, number, number?][] = [
	["Inbox/Call the landlord.md", 1],
	["Inbox/Gift ideas.md", 3],
	["Projects/Website redesign.md", 2],
	["Projects/Website redesign - copy deck.md", 12],
	["Projects/Garden plan 2026.md", 45],
	["Projects/Kitchen renovation.md", 140],
	["Areas/Health/Running log.md", 6],
	["Areas/Health/Sleep experiments.md", 210],
	["Areas/Finance/Tax checklist.md", 300, 20],
	["Areas/Finance/Subscriptions audit.md", 420],
	["Resources/Books/Deep Work.md", 520],
	["Resources/Books/The Mom Test.md", 95],
	["Resources/Books/Four Thousand Weeks.md", 33],
	["Resources/Cooking/Sourdough starter.md", 610],
	["Resources/Cooking/Weeknight pasta.md", 70],
	["Resources/Dev/Git cheatsheet.md", 800, 400],
	["Resources/Dev/Regex notes.md", 260],
	["Resources/Dev/TypeScript generics.md", 15],
	["Zettel/Attention is a budget.md", 980],
	["Zettel/Defaults shape behaviour.md", 380],
	["Zettel/Small bets.md", 120],
	["Zettel/Writing is thinking.md", 25],
	["Zettel/Compounding notes.md", 700],
];
const notes: FakeNote[] = spec.map(([path, edit, rev]) => ({ path, mtime: d(edit), ctime: d(edit + 30), fm: rev !== undefined ? { reviewed: iso(rev) } : undefined }));

// render a fake file explorer
const exp = document.getElementById("explorer")!;
const tree = exp.querySelector(".nav-files-container")!;
const folders = new Map<string, HTMLElement>();
for (const n of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
	const parts = n.path.split("/");
	let parent = tree as HTMLElement;
	let acc = "";
	for (let i = 0; i < parts.length - 1; i++) {
		acc = acc ? acc + "/" + parts[i] : parts[i];
		let f = folders.get(acc);
		if (!f) {
			const folder = (parent as any).createDiv({ cls: "tree-item nav-folder" });
			const t = folder.createDiv({ cls: "tree-item-self nav-folder-title is-clickable" });
			t.setAttribute("data-path", acc);
			t.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: parts[i] });
			f = folder.createDiv({ cls: "tree-item-children nav-folder-children" });
			folders.set(acc, f!);
		}
		parent = f!;
	}
	const item = (parent as any).createDiv({ cls: "tree-item nav-file" });
	const t = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable" });
	t.setAttribute("data-path", n.path);
	t.createDiv({ cls: "tree-item-inner nav-file-title-content", text: parts[parts.length - 1].replace(/\.md$/, "") });
}

(async () => {
	const app = new App(notes, document.getElementById("right")!, exp);
	const plugin = new (Plugin as any)(app, { dir: ".obsidian/plugins/note-aging", id: "note-aging" });
	await plugin.onload();
	const q = new URLSearchParams(location.search);
	if (q.get("badge")) { plugin.settings.showBadge = true; }
	if (q.get("style")) { plugin.settings.explorerStyle = q.get("style"); }
	await plugin.saveSettings();
	await plugin.openView();
	const f = app.vault.getFileByPath("Resources/Books/Deep Work.md")!;
	app.workspace.active = f;
	app.workspace.trigger("file-open", f);
	document.querySelector(`.nav-file-title[data-path="${f.path}"]`)?.classList.add("is-active");
	document.getElementById("editor-title")!.textContent = f.basename;
	(window as any).app = app; (window as any).plugin = plugin;
	if (q.get("settings")) {
		const tab = (window as any).__settingTab; tab.display();
		const r = document.getElementById("right")!; r.innerHTML = ""; r.appendChild(tab.containerEl); r.style.width = "620px";
	}
})();
