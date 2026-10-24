/**
 * Optional user configuration: `~/.pi/agent/anymodel.json`.
 *
 * ```json
 * { "output": "~/Pictures/anymodel" }
 * ```
 *
 * The file is optional and re-read on every use, so edits apply without a
 * restart. A malformed file is reported once and ignored.
 *
 * Override the file location with `PI_ANYMODEL_CONFIG` (used by the tests).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AnymodelConfig {
	/**
	 * Directory for generated images. `~` expands to the home directory;
	 * relative paths resolve against the current working directory of pi.
	 */
	output?: string;
}

export const DEFAULT_MEDIA_DIR_NAME = "anymodel-media";

let warnedAboutConfig = false;

export function configPath(): string {
	const override = process.env.PI_ANYMODEL_CONFIG;
	return override && override.trim().length > 0 ? override : join(getAgentDir(), "anymodel.json");
}

export function defaultMediaDir(): string {
	return join(getAgentDir(), DEFAULT_MEDIA_DIR_NAME);
}

/** Read the config file. Missing or malformed files yield `{}`. */
export function loadConfig(): AnymodelConfig {
	const path = configPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	if (raw.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		const output = (parsed as Record<string, unknown>).output;
		if (output !== undefined && typeof output !== "string") {
			throw new Error('"output" must be a string');
		}
		return output === undefined ? {} : { output };
	} catch (error) {
		if (!warnedAboutConfig) {
			warnedAboutConfig = true;
			console.warn(
				`[anymodel] ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return {};
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** Effective directory for generated images. */
export function resolveMediaDir(): string {
	const configured = loadConfig().output?.trim();
	if (!configured) return defaultMediaDir();
	const expanded = expandHome(configured);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}
