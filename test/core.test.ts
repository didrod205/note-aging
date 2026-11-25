import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseDateValue, daysBetween, bucketFor, computeAge, isExcluded, shortAge, longAge,
	weightedPick, todayString, cleanThresholds, countByBucket, sortOldestFirst, DEFAULT_SETTINGS, DAY, NoteAge,
} from "../src/core";

const NOW = new Date(2026, 10, 25, 13, 0, 0).getTime(); // 2026-11-25 13:00 local

test("parseDateValue handles common formats", () => {
	assert.equal(parseDateValue("2026-11-20"), new Date(2026, 10, 20).getTime());
	assert.equal(parseDateValue("2026-11-20T08:30"), new Date(2026, 10, 20, 8, 30).getTime());
	assert.equal(parseDateValue("2026-11-20 08:30:15"), new Date(2026, 10, 20, 8, 30, 15).getTime());
	assert.equal(parseDateValue("[[2026-11-20]]"), new Date(2026, 10, 20).getTime());
	assert.equal(parseDateValue(["2025-01-01", "2026-03-04", "2024-12-31"]), new Date(2026, 2, 4).getTime());
	assert.equal(parseDateValue(1700000000), 1700000000 * 1000);
	assert.equal(parseDateValue(1700000000000), 1700000000000);
	assert.equal(parseDateValue("2026-02-31"), null);
	assert.equal(parseDateValue("next week"), null);
	assert.equal(parseDateValue(""), null);
	assert.equal(parseDateValue(undefined), null);
	assert.equal(parseDateValue({}), null);
});

test("daysBetween uses calendar days and never goes negative", () => {
	assert.equal(daysBetween(new Date(2026, 10, 24, 23, 59).getTime(), new Date(2026, 10, 25, 0, 1).getTime()), 1);
	assert.equal(daysBetween(NOW, NOW), 0);
	assert.equal(daysBetween(NOW + 5 * DAY, NOW), 0);
	assert.equal(daysBetween(new Date(2025, 10, 25).getTime(), NOW), 365);
});

test("bucketFor respects thresholds", () => {
	const t: [number, number, number] = [30, 90, 365];
	assert.equal(bucketFor(0, t), "fresh");
	assert.equal(bucketFor(29, t), "fresh");
	assert.equal(bucketFor(30, t), "aging");
	assert.equal(bucketFor(89, t), "aging");
	assert.equal(bucketFor(90, t), "old");
	assert.equal(bucketFor(364, t), "old");
	assert.equal(bucketFor(365, t), "stale");
});

test("computeAge prefers the property and falls back to mtime", () => {
	const mtime = NOW - 2 * DAY;
	const ctime = NOW - 800 * DAY;
	const withProp = computeAge({ path: "a.md", mtime, ctime, propertyValue: "2026-01-01" }, DEFAULT_SETTINGS, NOW);
	assert.equal(withProp.from, "property");
	assert.equal(withProp.days, 328);
	assert.equal(withProp.bucket, "old");
	const noProp = computeAge({ path: "b.md", mtime, ctime }, DEFAULT_SETTINGS, NOW);
	assert.equal(noProp.from, "modified");
	assert.equal(noProp.days, 2);
	const badProp = computeAge({ path: "c.md", mtime, ctime, propertyValue: "soon" }, DEFAULT_SETTINGS, NOW);
	assert.equal(badProp.from, "modified");
	const created = computeAge({ path: "d.md", mtime, ctime, propertyValue: "2026-01-01" }, { ...DEFAULT_SETTINGS, source: "created" }, NOW);
	assert.equal(created.from, "created");
	assert.equal(created.bucket, "stale");
	const modified = computeAge({ path: "e.md", mtime, ctime, propertyValue: "2020-01-01" }, { ...DEFAULT_SETTINGS, source: "modified" }, NOW);
	assert.equal(modified.days, 2);
});

test("isExcluded matches folders, not name prefixes", () => {
	assert.equal(isExcluded("Journal/2026-11-25.md", ["Journal"]), true);
	assert.equal(isExcluded("Journal/2026/11.md", ["/Journal/"]), true);
	assert.equal(isExcluded("Journaling tips.md", ["Journal"]), false);
	assert.equal(isExcluded("Work/Journal/x.md", ["Journal"]), false);
	assert.equal(isExcluded("Work/Journal/x.md", ["Work/Journal"]), true);
	assert.equal(isExcluded("x.md", ["", "  "]), false);
});

test("age labels", () => {
	assert.equal(shortAge(0), "today");
	assert.equal(shortAge(5), "5d");
	assert.equal(shortAge(20), "2w");
	assert.equal(shortAge(100), "3mo");
	assert.equal(shortAge(365), "1y");
	assert.equal(shortAge(550), "1.5y");
	assert.equal(shortAge(4000), "10y");
	assert.equal(longAge(1), "yesterday");
	assert.equal(longAge(40), "5 weeks ago");
	assert.equal(longAge(31 * 1), "4 weeks ago");
	assert.equal(longAge(65), "2 months ago");
	assert.equal(longAge(400), "over a year ago");
	assert.equal(longAge(800), "over 2 years ago");
});

function mk(days: number[]): NoteAge[] {
	return days.map((d, i) => ({ path: `n${i}.md`, since: NOW - d * DAY, days: d, bucket: bucketFor(d, [30, 90, 365]), from: "modified" }));
}

test("weightedPick respects the minimum age and favours older notes", () => {
	const ages = mk([1, 10, 100, 200, 1000]);
	assert.equal(weightedPick(ages, 5000, 3), null);
	for (let i = 0; i < 50; i++) {
		const p = weightedPick(ages, 90, 3)!;
		assert.ok(p.days >= 90);
	}
	// deterministic: rnd near 1 picks the last (oldest) candidate
	assert.equal(weightedPick(ages, 90, 3, () => 0.999)!.days, 1000);
	assert.equal(weightedPick(ages, 90, 3, () => 0)!.days, 100);
	// frequency check with a seeded generator
	let seed = 42;
	const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	const hits: Record<number, number> = {};
	for (let i = 0; i < 6000; i++) {
		const d = weightedPick(ages, 90, 3, rnd)!.days;
		hits[d] = (hits[d] ?? 0) + 1;
	}
	assert.ok(hits[1000] > hits[100] * 2, `oldest should be picked ~3x more: ${JSON.stringify(hits)}`);
	// weight 1 is roughly uniform
	const uni: Record<number, number> = {};
	for (let i = 0; i < 6000; i++) {
		const d = weightedPick(ages, 90, 1, rnd)!.days;
		uni[d] = (uni[d] ?? 0) + 1;
	}
	assert.ok(Math.abs(uni[1000] - uni[100]) < 400, JSON.stringify(uni));
});

test("counting, sorting and helpers", () => {
	const ages = mk([1, 40, 100, 400, 500]);
	assert.deepEqual(countByBucket(ages), { fresh: 1, aging: 1, old: 1, stale: 2 });
	assert.deepEqual(sortOldestFirst(ages).map((a) => a.days), [500, 400, 100, 40, 1]);
	assert.equal(todayString(NOW), "2026-11-25");
	assert.deepEqual(cleanThresholds([90, 30, 365]), [30, 90, 365]);
	assert.deepEqual(cleanThresholds([10, 10, 10]), [10, 11, 12]);
	assert.deepEqual(cleanThresholds([-5, NaN as unknown as number, 7]), [1, 2, 7]);
});
