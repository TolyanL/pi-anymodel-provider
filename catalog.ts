/**
 * AnyModel catalog: discovery from `GET /v1/models`, mapping to pi model
 * definitions, and a local snapshot for offline startup.
 *
 * The catalog is also the source of truth for billing: every chat model
 * carries a `billing.coefficient` that converts raw tokens into AnyModel
 * balance tokens. The raw payload is stored verbatim so parsing lives in one
 * place and the snapshot always matches what the API returned.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "anymodel";
export const PROVIDER_NAME = "AnyModel";
export const BASE_URL = "https://anymodel.org/v1";
export const ENV_VARS = ["ANYMODEL_API_KEY", "ANYMODEL_KEY"] as const;

const API = "openai-completions" as const;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const SNAPSHOT_VERSION = 1;

/** AnyModel `kind` values that can be driven through `/v1/chat/completions`. */
const CHAT_KINDS = new Set(["llm", "chat", "text", "imageToText", "image-to-text"]);

/** AnyModel thinking hints that pi can express directly on an OpenAI endpoint. */
const PI_THINKING_FORMATS: Record<string, NonNullable<OpenAICompletionsCompat["thinkingFormat"]>> = {
	deepseek: "deepseek",
	zai: "zai",
	qwen: "qwen",
};

export interface Coefficient {
	input: number;
	output: number;
}

export interface CatalogModel {
	id: string;
	name: string;
	ownedBy: string;
	kind: string;
	reasoning: boolean;
	vision: boolean;
	input: ("text" | "image")[];
	/** Balance tokens charged per raw token. Undefined for combo routes, which publish no billing block. */
	coefficient?: Coefficient;
	thinkingFormat?: string;
	thinkingCanDisable?: boolean;
	contextWindow: number;
	maxTokens: number;
}

// ─── Untrusted JSON helpers ──────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
	const parsed = asNumber(value);
	return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : undefined;
}

// ─── Parsing ─────────────────────────────────────────────────────────

function parseCoefficient(billing: Record<string, unknown> | undefined): Coefficient | undefined {
	const coefficient = asRecord(billing?.coefficient);
	if (!coefficient) return undefined;
	const input = asNumber(coefficient.input);
	const output = asNumber(coefficient.output);
	if (input === undefined || output === undefined) return undefined;
	return { input, output };
}

function parseModel(raw: unknown): CatalogModel | undefined {
	const entry = asRecord(raw);
	if (!entry) return undefined;
	const id = asString(entry.id);
	if (!id) return undefined;

	const kind = asString(entry.kind) ?? "llm";
	if (!CHAT_KINDS.has(kind)) return undefined;

	const capabilities = asRecord(entry.capabilities) ?? {};
	const vision = asBoolean(capabilities.vision) ?? false;
	const billing = asRecord(entry.billing);
	const unit = asString(billing?.unit);
	const contextWindow =
		positiveInt(capabilities.contextWindow) ?? positiveInt(entry.context_length) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(
		positiveInt(capabilities.maxOutput) ?? positiveInt(entry.max_completion_tokens) ?? DEFAULT_MAX_TOKENS,
		contextWindow,
	);

	return {
		id,
		name: asString(entry.name) ?? id,
		ownedBy: asString(entry.owned_by) ?? "",
		kind,
		reasoning: asBoolean(capabilities.reasoning) ?? false,
		vision,
		input: vision ? ["text", "image"] : ["text"],
		// A non-token unit is never chat-billed, so treat it as unknown here.
		coefficient: unit === undefined || unit === "token" ? parseCoefficient(billing) : undefined,
		thinkingFormat: asString(capabilities.thinkingFormat),
		thinkingCanDisable: asBoolean(capabilities.thinkingCanDisable),
		contextWindow,
		maxTokens,
	};
}

/** Parse a `GET /v1/models` payload, dropping non-chat kinds and duplicates. */
export function parseCatalog(payload: unknown): CatalogModel[] {
	const data = asRecord(payload)?.data;
	if (!Array.isArray(data)) return [];
	const models: CatalogModel[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		const model = parseModel(raw);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

/** Convert a catalog entry into a pi model definition for the OpenAI-completions API. */
export function toModel(entry: CatalogModel): Model<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: entry.id,
		name: entry.name,
		api: API,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning: entry.reasoning,
		input: entry.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
	};

	const thinkingFormat = entry.thinkingFormat ? PI_THINKING_FORMATS[entry.thinkingFormat] : undefined;
	if (thinkingFormat) model.compat = { thinkingFormat };

	// Levels the model cannot turn off must not offer an "off" thinking level.
	if (entry.reasoning && entry.thinkingCanDisable === false) model.thinkingLevelMap = { off: null };

	return model;
}

// ─── In-memory catalog ───────────────────────────────────────────────

let catalog: CatalogModel[] = [];
const catalogById = new Map<string, CatalogModel>();
let snapshotFetchedAt: number | undefined;

export function setCatalog(models: readonly CatalogModel[], fetchedAt?: number): void {
	catalog = [...models];
	catalogById.clear();
	for (const model of catalog) catalogById.set(model.id, model);
	if (fetchedAt !== undefined) snapshotFetchedAt = fetchedAt;
}

export function getCatalog(): readonly CatalogModel[] {
	return catalog;
}

export function getCatalogModel(id: string): CatalogModel | undefined {
	return catalogById.get(id);
}

/** Balance-token coefficient for a model id, or undefined when the route publishes none. */
export function coefficientFor(id: string): Coefficient | undefined {
	return catalogById.get(id)?.coefficient;
}

export function snapshotAgeMs(now = Date.now()): number | undefined {
	return snapshotFetchedAt === undefined ? undefined : Math.max(0, now - snapshotFetchedAt);
}

/** How long a snapshot is considered fresh. `ANYMODEL_CATALOG_TTL_MS=0` refreshes every time. */
export function catalogTtlMs(): number {
	const raw = process.env.ANYMODEL_CATALOG_TTL_MS;
	if (raw !== undefined) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_TTL_MS;
}

// ─── Local snapshot ──────────────────────────────────────────────────

export function snapshotPath(): string {
	return join(getAgentDir(), `${PROVIDER_ID}-catalog.json`);
}

/** Read the stored raw `GET /v1/models` payload and record its fetch time. */
export function readSnapshotPayload(): unknown | undefined {
	try {
		const root = asRecord(JSON.parse(readFileSync(snapshotPath(), "utf8")) as unknown);
		if (!root || root.version !== SNAPSHOT_VERSION || !root.payload) return undefined;
		snapshotFetchedAt = asNumber(root.fetchedAt);
		return root.payload;
	} catch {
		return undefined;
	}
}

export function writeSnapshotPayload(payload: unknown): void {
	const fetchedAt = Date.now();
	try {
		const file = snapshotPath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ version: SNAPSHOT_VERSION, provider: PROVIDER_ID, fetchedAt, payload }),
			"utf8",
		);
		snapshotFetchedAt = fetchedAt;
	} catch (error) {
		console.warn(
			`[anymodel] could not write catalog snapshot: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Load the snapshot into memory. Returns the number of chat models loaded. */
export function loadCatalogFromDisk(): number {
	const payload = readSnapshotPayload();
	loadMediaFromDisk();
	if (!payload) return 0;
	const models = parseCatalog(payload);
	setCatalog(models, snapshotFetchedAt);
	return models.length;
}

// ─── Network ─────────────────────────────────────────────────────────

/** Fetch the raw catalog payload. Free endpoint; never touches inference. */
export async function fetchCatalogPayload(apiKey: string, signal?: AbortSignal): Promise<unknown> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: combined,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`GET /v1/models → HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
	}
	return (await response.json()) as unknown;
}

// ─── Media models (images) ─────────────────────────────────────────

/** AnyModel image models, listed in `GET /v1/models`. */
export type MediaKind = "image";

export interface MediaModel {
	id: string;
	name: string;
	kind: MediaKind;
	ownedBy: string;
	/** Billing unit: `image`. */
	unit?: string;
	/** Fixed charge for one unit, present when the unit is not a token. */
	baseTokens?: number;
	/** Unit multipliers, e.g. `{ quality: {...}, size: {...} }`. */
	scales?: Record<string, Record<string, number>>;
	coefficient?: Coefficient;
	/** Parameters the catalog noted for this model. */
	params?: string[];
}

function parseNumberMap(value: unknown): Record<string, number> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const rates: Record<string, number> = {};
	for (const [key, raw] of Object.entries(record)) {
		const rate = asNumber(raw);
		if (rate !== undefined) rates[key] = rate;
	}
	return Object.keys(rates).length > 0 ? rates : undefined;
}

function parseScales(value: unknown): Record<string, Record<string, number>> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const scales: Record<string, Record<string, number>> = {};
	for (const [name, raw] of Object.entries(record)) {
		const entries = parseNumberMap(raw);
		if (entries) scales[name] = entries;
	}
	return Object.keys(scales).length > 0 ? scales : undefined;
}

const MEDIA_KINDS = new Set<string>(["image"]);

function parseMediaModel(raw: unknown): MediaModel | undefined {
	const entry = asRecord(raw);
	if (!entry) return undefined;
	const id = asString(entry.id);
	const kind = asString(entry.kind);
	if (!id || !kind || !MEDIA_KINDS.has(kind)) return undefined;
	const billing = asRecord(entry.billing);
	return {
		id,
		name: asString(entry.name) ?? id,
		kind: kind as MediaKind,
		ownedBy: asString(entry.owned_by) ?? "",
		unit: asString(billing?.unit),
		baseTokens: positiveInt(billing?.base_tokens),
		scales: parseScales(billing?.scales),
		coefficient: parseCoefficient(billing),
		params: Array.isArray(entry.params)
			? entry.params.filter((param): param is string => typeof param === "string")
			: undefined,
	};
}

/** Parse image entries from a `GET /v1/models` payload. */
export function parseMediaModels(payload: unknown): MediaModel[] {
	const data = asRecord(payload)?.data;
	if (!Array.isArray(data)) return [];
	const models: MediaModel[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		const model = parseMediaModel(raw);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

let mediaModels: MediaModel[] = [];
const mediaById = new Map<string, MediaModel>();

export function setMediaModels(models: readonly MediaModel[]): void {
	mediaModels = [...models];
	mediaById.clear();
	for (const model of mediaModels) mediaById.set(model.id, model);
}

export function getMediaModels(kind?: MediaKind): readonly MediaModel[] {
	return kind ? mediaModels.filter((model) => model.kind === kind) : mediaModels;
}

export function getMediaModel(id: string): MediaModel | undefined {
	return mediaById.get(id);
}

/** Reload image models from the main snapshot. */
export function loadMediaFromDisk(): number {
	setMediaModels(parseMediaModels(readSnapshotPayload()));
	return mediaModels.length;
}
