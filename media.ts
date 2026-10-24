/**
 * AnyModel image generation.
 *
 * Deliberately free of pi APIs beyond the media directory and the PNG
 * conversion, so the whole flow is testable with a stubbed `fetch`.
 *
 * Billing follows the catalog:
 * `ceil(round(base_tokens × quality × size) × delivered × coefficient.output)`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import { BASE_URL, getMediaModel, type Coefficient, type MediaModel } from "./catalog.ts";
import { resolveMediaDir } from "./config.ts";

const IMAGE_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** AnyModel clamps larger values; bill for what actually arrives. */
export const MAX_IMAGES = 10;

export interface ImageRequest {
	model: string;
	prompt: string;
	n?: number;
	size?: string;
	quality?: string;
	outputFormat?: string;
	/** Reference images as data URLs. */
	images?: string[];
}

export interface ImageFile {
	path: string;
	mimeType: string;
	bytes: number;
	/** Base64 payload, for attaching the image to a tool result or message. */
	data: string;
	/** PNG payload for previews: pi's custom-message renderer only renders PNG. */
	previewData: string;
	previewMimeType: string;
}

export interface ImageOutcome {
	files: ImageFile[];
	/** Balance tokens, computed from the delivered images. */
	billed: number;
	model: MediaModel;
	/** Number of images requested, before delivery clamping. */
	requested: number;
	revisedPrompts: string[];
}

/** Directory for generated images: `output` from anymodel.json, or the default. */
export function mediaDir(): string {
	return resolveMediaDir();
}

function ensureMediaDir(): string {
	const dir = mediaDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ─── Pricing ─────────────────────────────────────────────────────────

function charge(rawUnits: number, coefficient: Coefficient | undefined): number {
	if (!coefficient) return 0;
	if (coefficient.input === 0 && coefficient.output === 0) return 0;
	return Math.max(1, Math.ceil(rawUnits * coefficient.output));
}

/** Multiplier from `billing.scales[group][key]`; 1 when the group is unpriced. */
function scaleFactor(model: MediaModel, group: string, key: string | undefined): number {
	const entries = model.scales?.[group];
	if (!entries) return 1;
	if (key === undefined) return 1;
	const value = entries[key];
	if (value === undefined) {
		throw new Error(
			`${model.id}: unsupported ${group} "${key}". Available: ${Object.keys(entries).join(", ")}`,
		);
	}
	return value;
}

export function estimateImageCost(
	model: MediaModel,
	options: { n: number; size?: string; quality?: string },
): number {
	const perImage = Math.round(
		(model.baseTokens ?? 0) * scaleFactor(model, "quality", options.quality) * scaleFactor(model, "size", options.size),
	);
	return charge(perImage * options.n, model.coefficient);
}

// ─── Files ───────────────────────────────────────────────────────────

function extensionForMime(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	if (mimeType === "image/webp") return "webp";
	if (mimeType === "image/gif") return "gif";
	return "png";
}

export function mimeFromOutputFormat(format: string | undefined): string {
	if (!format) return "image/png";
	if (format === "jpeg" || format === "jpg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function sniffImageMime(buffer: Buffer): string | undefined {
	if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
	if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
	if (buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF") return "image/webp";
	if (buffer.length > 3 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
	return undefined;
}

function slug(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return cleaned || "media";
}

/** PNG payload for previews; pi's custom-message renderer only renders PNG. */
async function previewPayload(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string }> {
	if (mimeType === "image/png") return { data: base64Data, mimeType };
	try {
		const converted = await convertToPng(base64Data, mimeType);
		if (converted) return converted;
	} catch {
		// Fall through to the original payload.
	}
	return { data: base64Data, mimeType };
}

function saveMediaFile(buffer: Buffer, mimeType: string, nameHint: string, index = 0): string {
	const dir = ensureMediaDir();
	const suffix = index > 0 ? `-${index}` : "";
	const file = join(dir, `${Date.now()}${suffix}-${slug(nameHint)}.${extensionForMime(mimeType)}`);
	writeFileSync(file, buffer);
	return file;
}

// ─── HTTP helpers ────────────────────────────────────────────────────

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorDetail(body: unknown): string {
	if (typeof body !== "object" || body === null) return "";
	const error = (body as Record<string, unknown>).error;
	if (typeof error === "object" && error !== null) {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === "string") return message;
	}
	return "";
}

function requireImageModel(id: string): MediaModel {
	const model = getMediaModel(id);
	if (!model) throw new Error(`Unknown AnyModel image model: ${id}`);
	if (model.kind !== "image") throw new Error(`${id} is not an image model`);
	return model;
}

// ─── Images ──────────────────────────────────────────────────────────

interface RawImage {
	b64Json?: string;
	url?: string;
	revisedPrompt?: string;
}

async function requestImages(
	apiKey: string,
	request: ImageRequest,
	n: number,
	signal: AbortSignal | undefined,
): Promise<RawImage[]> {
	const body: Record<string, unknown> = {
		model: request.model,
		prompt: request.prompt,
		n,
		response_format: "b64_json",
	};
	if (request.size) body.size = request.size;
	if (request.quality) body.quality = request.quality;
	if (request.outputFormat) body.output_format = request.outputFormat;
	if (request.images?.length) body.images = request.images;

	const response = await fetch(`${BASE_URL}/images/generations`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: withTimeout(signal, IMAGE_TIMEOUT_MS),
	});
	const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if (!response.ok) {
		throw new Error(
			`POST /v1/images/generations → HTTP ${response.status}${errorDetail(payload) ? `: ${errorDetail(payload)}` : ""}`,
		);
	}
	const data = Array.isArray(payload?.data) ? payload.data : [];
	const images: RawImage[] = [];
	for (const raw of data) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as Record<string, unknown>;
		images.push({
			b64Json: typeof entry.b64_json === "string" ? entry.b64_json : undefined,
			url: typeof entry.url === "string" ? entry.url : undefined,
			revisedPrompt: typeof entry.revised_prompt === "string" ? entry.revised_prompt : undefined,
		});
	}
	return images;
}

async function imageBytes(entry: RawImage, signal: AbortSignal | undefined): Promise<Buffer | undefined> {
	if (entry.b64Json) return Buffer.from(entry.b64Json, "base64");
	if (!entry.url) return undefined;
	const response = await fetch(entry.url, { signal: withTimeout(signal, DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`image download → HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

export async function generateImages(
	apiKey: string,
	request: ImageRequest,
	signal?: AbortSignal,
): Promise<ImageOutcome> {
	const model = requireImageModel(request.model);
	const requested = Math.min(Math.max(Math.trunc(request.n ?? 1), 1), MAX_IMAGES);
	// Validate request parameters before spending anything.
	estimateImageCost(model, { n: requested, size: request.size, quality: request.quality });

	const raw = await requestImages(apiKey, request, requested, signal);
	const files: ImageFile[] = [];
	const revisedPrompts: string[] = [];
	for (const [index, entry] of raw.entries()) {
		const buffer = await imageBytes(entry, signal);
		if (!buffer) continue;
		const mimeType = sniffImageMime(buffer) ?? mimeFromOutputFormat(request.outputFormat);
		const base64 = buffer.toString("base64");
		const preview = await previewPayload(base64, mimeType);
		files.push({
			path: saveMediaFile(buffer, mimeType, request.prompt, index + 1),
			mimeType,
			bytes: buffer.length,
			data: base64,
			previewData: preview.data,
			previewMimeType: preview.mimeType,
		});
		if (entry.revisedPrompt) revisedPrompts.push(entry.revisedPrompt);
	}
	if (files.length === 0) throw new Error("AnyModel returned no image data");

	const billed = estimateImageCost(model, { n: files.length, size: request.size, quality: request.quality });
	return { files, billed, model, requested, revisedPrompts };
}
