/**
 * AnyModel balance-token accounting.
 *
 * AnyModel charges `ceil(prompt_tokens × coefficient.input + completion_tokens
 * × coefficient.output)` balance tokens per chat request, where
 * `prompt_tokens` is the full input count (cache reads are a subset, not a
 * discount) and a non-zero route costs at least 1 balance token. Combo routes
 * publish no coefficient, so their cost is reported as unknown.
 *
 * pi reports `usage.input` with cache reads/writes already subtracted, so the
 * billed prompt is `input + cacheRead + cacheWrite`.
 */

import type { Coefficient } from "./catalog.ts";

export interface RequestUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelUsageTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Full raw prompt: input + cacheRead + cacheWrite. */
	rawPrompt: number;
	/** rawPrompt + output. */
	rawTotal: number;
	/** Balance tokens, summed over requests with a known coefficient. */
	billed: number;
	/** Requests whose model publishes no coefficient (combo routes). */
	unknownCoefficient: number;
	/** Image generations, which have no token counters. */
	mediaRequests: number;
	/** Balance tokens spent on image generation. */
	mediaBilled: number;
}

export interface LastRequest {
	model: string;
	at: number;
	/** Prompt tokens without cache. */
	input: number;
	/** Cache-read tokens included in rawPrompt. */
	cacheRead: number;
	output: number;
	rawPrompt: number;
	rawTotal: number;
	/** Undefined when the model publishes no coefficient. */
	billed?: number;
}

export interface UsageTotals extends ModelUsageTotals {
	byModel: Map<string, ModelUsageTotals>;
	last?: LastRequest;
}

export function emptyModelTotals(): ModelUsageTotals {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		rawPrompt: 0,
		rawTotal: 0,
		billed: 0,
		unknownCoefficient: 0,
		mediaRequests: 0,
		mediaBilled: 0,
	};
}

export function emptyTotals(): UsageTotals {
	return { ...emptyModelTotals(), byModel: new Map() };
}

export function totalRawPrompt(usage: RequestUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** All raw tokens of one request: prompt (cache included) + completion. */
export function requestRawTotal(usage: RequestUsage): number {
	return totalRawPrompt(usage) + usage.output;
}

/** Balance tokens charged for one request, or undefined when the coefficient is unknown. */
export function billedFor(coefficient: Coefficient | undefined, usage: RequestUsage): number | undefined {
	if (!coefficient) return undefined;
	const raw = Math.ceil(totalRawPrompt(usage) * coefficient.input + usage.output * coefficient.output);
	if (coefficient.input === 0 && coefficient.output === 0) return 0;
	return Math.max(1, raw);
}

function accumulate(target: ModelUsageTotals, usage: RequestUsage, billed: number | undefined): void {
	const rawPrompt = totalRawPrompt(usage);
	target.requests += 1;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.rawPrompt += rawPrompt;
	target.rawTotal += rawPrompt + usage.output;
	if (billed === undefined) target.unknownCoefficient += 1;
	else target.billed += billed;
}

/** Record one completed assistant message. */
export function addRequest(
	totals: UsageTotals,
	modelId: string,
	usage: RequestUsage,
	coefficient: Coefficient | undefined,
): void {
	const billed = billedFor(coefficient, usage);
	accumulate(totals, usage, billed);

	const perModel = totals.byModel.get(modelId) ?? emptyModelTotals();
	accumulate(perModel, usage, billed);
	totals.byModel.set(modelId, perModel);

	totals.last = {
		model: modelId,
		at: Date.now(),
		input: usage.input,
		cacheRead: usage.cacheRead,
		output: usage.output,
		rawPrompt: totalRawPrompt(usage),
		rawTotal: totalRawPrompt(usage) + usage.output,
		billed,
	};
}

/** Record one image generation, which is billed without token counters. */
export function addMediaSpend(totals: UsageTotals, modelId: string, billed: number): void {
	totals.mediaRequests += 1;
	totals.mediaBilled += billed;
	totals.billed += billed;

	const perModel = totals.byModel.get(modelId) ?? emptyModelTotals();
	perModel.mediaRequests += 1;
	perModel.mediaBilled += billed;
	perModel.billed += billed;
	totals.byModel.set(modelId, perModel);
}

// ─── Formatting ──────────────────────────────────────────────────────

/** Compact token counts: 1234 → 1.2k, 12200 → 12.2k, 36000 → 36k, 10694846 → 10.69M. */
export function formatTokens(value: number): string {
	if (!Number.isFinite(value)) return "?";
	if (value < 0) return `-${formatTokens(-value)}`;
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) {
		const thousands = value / 1000;
		return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/u, "") : Math.round(thousands)}k`;
	}
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${(value / 1_000_000_000).toFixed(2)}B`;
}

/** Exact count with thousands separators. */
export function formatExact(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

export function describeCoefficient(coefficient: Coefficient | undefined): string {
	if (!coefficient) return "unknown (combo route)";
	if (coefficient.input === 0 && coefficient.output === 0) return "×0 (free)";
	if (coefficient.input === coefficient.output) return `×${coefficient.input}`;
	return `in ×${coefficient.input} / out ×${coefficient.output}`;
}

/** Models sorted by balance tokens spent, descending. */
export function topModels(totals: UsageTotals, limit: number): { id: string; totals: ModelUsageTotals }[] {
	return [...totals.byModel.entries()]
		.map(([id, modelTotals]) => ({ id, totals: modelTotals }))
		.sort((a, b) => b.totals.rawTotal - a.totals.rawTotal)
		.slice(0, limit);
}
