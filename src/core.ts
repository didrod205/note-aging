// Pure logic, no Obsidian imports. Unit-tested in test/core.test.ts.

export const DAY = 86_400_000;

export type Bucket = "fresh" | "aging" | "old" | "stale";
export const BUCKETS: Bucket[] = ["fresh", "aging", "old", "stale"];

export type AgeSource = "property" | "modified" | "created";

export interface AgingSettings {
	/** Where the age comes from. "property" falls back to the modified time when the note has no such property. */
	source: AgeSource;
	/** Frontmatter key that stores the last review date. */
	property: string;
	/** Upper bounds (in days) for fresh, aging and old. Anything older is stale. */
	thresholds: [number, number, number];
	/** Folders to leave out, one path per entry. */
	excludeFolders: string[];
	/** Explorer style. */
	explorerStyle: "fade" | "dot" | "off";
	showBadge: boolean;
	showStatusBar: boolean;
	/** Random note only picks notes at least this many days old. */
	randomMinDays: number;
	/** Weight multiplier for older notes in the random pick. 1 means uniform. */
	randomWeight: number;
}

export const DEFAULT_SETTINGS: AgingSettings = {
	source: "property",
	property: "reviewed",
	thresholds: [30, 90, 365],
	excludeFolders: [],
	explorerStyle: "fade",
	showBadge: false,
	showStatusBar: true,
	randomMinDays: 90,
	randomWeight: 3,
};

export interface NoteInfo {
	path: string;
	mtime: number;
	ctime: number;
	/** Raw frontmatter value of the review property, if any. */
	propertyValue?: unknown;
}

export interface NoteAge {
	path: string;
	/** Timestamp the age is measured from. */
	since: number;
	days: number;
	bucket: Bucket;
	/** What the timestamp came from. */
	from: "property" | "modified" | "created";
}

/** Parse a date-ish frontmatter value. Accepts YYYY-MM-DD, ISO strings, YYYY-MM-DDTHH:mm, Date objects and epoch ms. */
export function parseDateValue(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	if (Array.isArray(v)) {
		// some people keep a review log; use the latest entry
		let best: number | null = null;
		for (const x of v) {
			const t = parseDateValue(x);
			if (t !== null && (best === null || t > best)) best = t;
		}
		return best;
	}
	if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
	if (typeof v === "number") {
		if (!isFinite(v)) return null;
		// treat small numbers as seconds
		return v < 1e11 ? v * 1000 : v;
	}
	if (typeof v !== "string") return null;
	const s = v.trim().replace(/^\[\[|\]\]$/g, "");
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
	if (m) {
		const [, y, mo, d, h, mi, se] = m;
		const t = new Date(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, se ? +se : 0).getTime();
		if (isNaN(t)) return null;
		// reject impossible dates such as 2026-02-31
		const chk = new Date(t);
		if (chk.getMonth() !== +mo - 1) return null;
		return t;
	}
	return null;
}

/** Whole days between two timestamps, using local calendar days. Never negative. */
export function daysBetween(from: number, now: number): number {
	const a = new Date(from);
	const b = new Date(now);
	const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
	const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
	return Math.max(0, Math.round((db - da) / DAY));
}

export function bucketFor(days: number, t: [number, number, number]): Bucket {
	if (days < t[0]) return "fresh";
	if (days < t[1]) return "aging";
	if (days < t[2]) return "old";
	return "stale";
}

export function computeAge(n: NoteInfo, s: AgingSettings, now: number): NoteAge {
	let since: number;
	let from: NoteAge["from"];
	if (s.source === "created") {
		since = n.ctime;
		from = "created";
	} else if (s.source === "modified") {
		since = n.mtime;
		from = "modified";
	} else {
		const p = parseDateValue(n.propertyValue);
		if (p !== null) {
			since = p;
			from = "property";
		} else {
			since = n.mtime;
			from = "modified";
		}
	}
	const days = daysBetween(since, now);
	return { path: n.path, since, days, bucket: bucketFor(days, s.thresholds), from };
}

export function normalizeFolder(f: string): string {
	return f.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function isExcluded(path: string, folders: string[]): boolean {
	for (const raw of folders) {
		const f = normalizeFolder(raw);
		if (!f) continue;
		if (path === f || path.startsWith(f + "/")) return true;
	}
	return false;
}

/** Short label: "today", "3d", "5w", "4mo", "2y". */
export function shortAge(days: number): string {
	if (days <= 0) return "today";
	if (days < 14) return `${days}d`;
	if (days < 60) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	const y = days / 365;
	return y < 10 ? `${Math.floor(y * 10) / 10}y`.replace(".0y", "y") : `${Math.floor(y)}y`;
}

/** Longer label for the status bar and tooltips. */
export function longAge(days: number): string {
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 14) return `${days} days ago`;
	if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
	if (days < 365) {
		const m = Math.floor(days / 30);
		return m === 1 ? "1 month ago" : `${m} months ago`;
	}
	const y = Math.floor(days / 365);
	return y === 1 ? "over a year ago" : `over ${y} years ago`;
}

export function countByBucket(ages: NoteAge[]): Record<Bucket, number> {
	const c: Record<Bucket, number> = { fresh: 0, aging: 0, old: 0, stale: 0 };
	for (const a of ages) c[a.bucket]++;
	return c;
}

/** Oldest first; ties broken by path so the order is stable. */
export function sortOldestFirst(ages: NoteAge[]): NoteAge[] {
	return [...ages].sort((a, b) => a.since - b.since || a.path.localeCompare(b.path));
}

/**
 * Pick a note at random, older notes more likely.
 * weight = 1 gives a uniform pick; weight = 3 makes the oldest note 3x as likely as the youngest eligible one.
 */
export function weightedPick(ages: NoteAge[], minDays: number, weight: number, rnd: () => number = Math.random): NoteAge | null {
	const pool = ages.filter((a) => a.days >= minDays);
	if (!pool.length) return null;
	const minD = Math.min(...pool.map((a) => a.days));
	const maxD = Math.max(...pool.map((a) => a.days));
	const span = maxD - minD;
	const w = Math.max(1, weight);
	const weights = pool.map((a) => (span === 0 ? 1 : 1 + ((a.days - minD) / span) * (w - 1)));
	const total = weights.reduce((x, y) => x + y, 0);
	let r = rnd() * total;
	for (let i = 0; i < pool.length; i++) {
		r -= weights[i];
		if (r < 0) return pool[i];
	}
	return pool[pool.length - 1];
}

/** Local date as YYYY-MM-DD, the value written to the review property. */
export function todayString(now: number): string {
	const d = new Date(now);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Validate thresholds coming from the settings UI. Returns a sorted, positive triple. */
export function cleanThresholds(t: number[]): [number, number, number] {
	const v = t.map((x) => Math.max(1, Math.round(Number(x) || 1)));
	while (v.length < 3) v.push(v[v.length - 1] ?? 30);
	const s = v.slice(0, 3).sort((a, b) => a - b);
	// keep them strictly increasing
	if (s[1] <= s[0]) s[1] = s[0] + 1;
	if (s[2] <= s[1]) s[2] = s[1] + 1;
	return [s[0], s[1], s[2]];
}
