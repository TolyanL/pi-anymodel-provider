/**
 * Custom pi footer for pi-anymodel-provider.
 *
 * pi's built-in footer renders a stats line with `↑in ↓out Rcache CHhit%` plus
 * context usage. Once the AM status reports in/out/btok and carries the context
 * percentage, that line is redundant, so this footer keeps everything else:
 *
 *   ~/proj (main) • session-name
 *   AM ↑2.77M ↓25.8k · 4.14M btok · 9.84M left · ctx 56.8%/200k   (anymodel) glm/glm-5.3 • high
 *   🔌 MCP: 1 server enabled
 *
 * The AM statistics take the left side of the model row — the space pi's own
 * token stats used to fill — and are excluded from the status row below it.
 * Other extension statuses stay on their own row, sorted by key.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";

export interface AnymodelFooterHost {
	/** Latest extension context; its methods read live runtime state. */
	context(): ExtensionContext | undefined;
	/** Status key pinned to the end of the status row. */
	statusKey: string;
}

export type FooterFactory = (
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
) => Component & { dispose?(): void };

export function createAnymodelFooter(host: AnymodelFooterHost): FooterFactory {
	return (tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			invalidate: () => {},
			dispose: () => unsubscribe(),
			render: (width: number) => renderFooter(width, theme, footerData, host),
		};
	};
}

/** Single-line status text, matching the built-in footer's sanitizing. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Collapse the home directory to `~`, like the built-in footer. */
export function formatCwdForFooter(cwd: string, home = process.env.HOME || process.env.USERPROFILE): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface FooterView {
	pwd: string;
	model: { id: string; provider: string; reasoning: boolean } | undefined;
	thinkingLevel: string | undefined;
}

const EMPTY_VIEW: FooterView = { pwd: "", model: undefined, thinkingLevel: undefined };

/**
 * Read the ctx-derived fields defensively: after a session replacement or
 * reload every ctx getter throws, and a throwing footer render would break the
 * terminal UI.
 */
function readView(ctx: ExtensionContext | undefined, footerData: ReadonlyFooterDataProvider): FooterView {
	if (!ctx) return EMPTY_VIEW;
	try {
		void ctx.hasUI;
		const sessionManager = ctx.sessionManager;
		let pwd = "";
		if (sessionManager && typeof sessionManager.getCwd === "function") {
			pwd = formatCwdForFooter(sessionManager.getCwd());
		}
		const branch = footerData.getGitBranch();
		if (branch) pwd += ` (${branch})`;
		const sessionName =
			sessionManager && typeof sessionManager.getSessionName === "function"
				? sessionManager.getSessionName()
				: undefined;
		if (sessionName) pwd += ` • ${sessionName}`;
		return { pwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel };
	} catch {
		return EMPTY_VIEW;
	}
}

function renderFooter(
	width: number,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	host: AnymodelFooterHost,
): string[] {
	const ctx = (() => {
		try {
			return host.context();
		} catch {
			return undefined;
		}
	})();
	const view = readView(ctx, footerData);
	const lines: string[] = [];

	lines.push(truncateToWidth(theme.fg("dim", view.pwd), width, theme.fg("dim", "...")));

	const model = view.model;
	const providerPrefix = model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ` : "";
	let right = model?.id ?? "no-model";
	if (model?.reasoning) {
		const level = view.thinkingLevel ?? "off";
		right += level === "off" ? " • thinking off" : ` • ${level}`;
	}
	const rightText = theme.fg("dim", `${providerPrefix}${right}`);

	const statuses = [...footerData.getExtensionStatuses().entries()];
	const ourStatus = footerData.getExtensionStatuses().get(host.statusKey);
	const left = ourStatus === undefined ? "" : sanitizeStatusText(ourStatus);

	// The AM statistics fill the space to the left of the right-aligned model,
	// like pi's built-in footer did with its token stats.
	lines.push(statsAndModelLine(left, rightText, width, theme));

	const others = statuses
		.filter(([key]) => key !== host.statusKey)
		.sort(([a], [b]) => a.localeCompare(b));
	if (others.length > 0) {
		const statusLine = others.map(([, text]) => sanitizeStatusText(text)).join("  ");
		if (statusLine.length > 0) {
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}
	}

	return lines;
}

/** Minimum gap between the statistics and the right-aligned model name. */
const MIN_GAP = 2;

function statsAndModelLine(left: string, right: string, width: number, theme: Theme): string {
	let leftText = left;
	let leftWidth = visibleWidth(leftText);
	if (leftWidth > width) {
		leftText = truncateToWidth(leftText, width, theme.fg("dim", "..."));
		leftWidth = visibleWidth(leftText);
	}

	const rightWidth = visibleWidth(right);
	if (leftWidth + MIN_GAP + rightWidth <= width) {
		return leftText + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	const availableForRight = width - leftWidth - MIN_GAP;
	if (availableForRight <= 0) return leftText;
	const truncatedRight = truncateToWidth(right, availableForRight, "");
	return leftText + " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight))) + truncatedRight;
}

/** Exported for tests. */
export { renderFooter };
