/**
 * pi-anymodel-provider — AnyModel provider + balance-token usage display.
 *
 * Provider: registers the `anymodel` provider (OpenAI-compatible gateway at
 * https://anymodel.org/v1) with a dynamically discovered model catalog and
 * `/login` support for an AnyModel API key.
 *
 * Usage: `/anymodel` reports session token spend converted to balance tokens
 * with the per-model coefficient, and the footer status shows the running
 * total plus the account balance.
 */

import {
  Type,
  createProvider,
  envApiKeyAuth,
  openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import { Image, Text, getCapabilities, type Component } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  addMediaSpend,
  addRequest,
  describeCoefficient,
  emptyTotals,
  formatExact,
  formatTokens,
  requestRawTotal,
  topModels,
  type UsageTotals,
} from "./billing.ts";
import { createAnymodelFooter } from "./footer.ts";
import { MAX_IMAGES, generateImages } from "./media.ts";
import {
  BASE_URL,
  ENV_VARS,
  PROVIDER_ID,
  PROVIDER_NAME,
  coefficientFor,
  catalogTtlMs,
  fetchCatalogPayload,
  getCatalog,
  getCatalogModel,
  getMediaModels,
  loadCatalogFromDisk,
  loadMediaFromDisk,
  parseCatalog,
  setCatalog,
  snapshotAgeMs,
  snapshotPath,
  toModel,
  writeSnapshotPayload,
  type MediaModel,
} from "./catalog.ts";

const STATUS_KEY = "pi-anymodel";
const BALANCE_TIMEOUT_MS = 10_000;
const CATALOG_REFRESH_TIMEOUT_MS = 8_000;
const CATALOG_REFRESH_ATTEMPTS = 3;
const CATALOG_REFRESH_RETRY_MS = 600;

interface Balance {
  balance: number;
  unlimited: boolean;
  status: string;
  fetchedAt: number;
}

interface State {
  totals: UsageTotals;
  balance?: Balance;
  /** Latest context; the custom footer reads live runtime state through it. */
  context?: ExtensionContext;
  footerEnabled: boolean;
  /** One balance request in flight; later requests coalesce into one follow-up. */
  balanceRefreshing: boolean;
  balanceQueued: boolean;
}

export default function anymodelExtension(pi: ExtensionAPI): void {
  const debug = (message: string): void => {
    if (process.env.ANYMODEL_DEBUG) console.error(`[anymodel] ${message}`);
  };
  debug("factory entered");
  const state: State = {
    totals: emptyTotals(),
    footerEnabled: true,
    balanceRefreshing: false,
    balanceQueued: false,
  };
  /** Startup catalog refresh runs once per extension instance (i.e. per pi launch). */
  let startupRefreshDone = false;

  const catalogSize = loadCatalogFromDisk();
  try {
    pi.registerProvider(buildProvider());
  } catch (error) {
    console.error(
      `[anymodel] provider registration failed: ${error instanceof Error ? error.stack : String(error)}`,
    );
    throw error;
  }
  debug(`provider registered with ${catalogSize} models from ${snapshotPath()}`);

  pi.on("session_start", async (_event, ctx) => {
    state.context = ctx;
    // Another process may have refreshed the snapshot since load.
    loadCatalogFromDisk();
    state.totals = restoreTotals(ctx);
    applyFooter(ctx, state);
    renderStatus(ctx, state);
    if (!startupRefreshDone) {
      startupRefreshDone = true;
      void refreshCatalog(ctx, state);
    }
    void scheduleBalanceRefresh(ctx, state);
  });

  pi.on("message_end", async (event, ctx) => {
    state.context = ctx;
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== PROVIDER_ID || !message.usage) return;
    // A request that produced no tokens is not charged, so it is not counted.
    if (requestRawTotal(message.usage) === 0) return;
    addRequest(state.totals, message.model, message.usage, coefficientFor(message.model));
    renderStatus(ctx, state);
    // Keep the footer's remaining balance current after every answer.
    void scheduleBalanceRefresh(ctx, state);
  });

  pi.on("model_select", async (event, ctx) => {
    state.context = ctx;
    applyFooter(ctx, state, event.model);
    renderStatus(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
    // Anything still in flight must not touch this session's ctx again.
    state.context = undefined;
  });

  pi.registerCommand("anymodel", {
    description: "AnyModel: token spend, account balance, and model catalog",
    getArgumentCompletions: (prefix) =>
      [
        {
          value: "image",
          label: "image <prompt>",
          description: "Generate images into ~/.pi/agent/anymodel-media",
        },
        { value: "refresh", label: "refresh", description: "Refresh the model catalog" },
        {
          value: "footer",
          label: "footer on|off",
          description: "Custom footer without pi's stats line",
        },
      ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => handleCommand(args, ctx, state, pi),
  });

  registerImageTool(pi, state);
  registerMediaRenderer(pi);
}

// ─── Provider ────────────────────────────────────────────────────────

function buildProvider() {
  return createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    auth: { apiKey: envApiKeyAuth(`${PROVIDER_NAME} API key`, [...ENV_VARS]) },
    models: getCatalog().map(toModel),
    fetchModels: async (context) => {
      const cached = getCatalog();
      const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      const age = snapshotAgeMs();
      const fresh = age !== undefined && age < catalogTtlMs();
      if (process.env.ANYMODEL_DEBUG) {
        console.error(
          `[anymodel] fetchModels: allowNetwork=${context.allowNetwork} force=${context.force} cached=${cached.length} age=${age === undefined ? "none" : Math.round(age / 1000) + "s"} fresh=${fresh} key=${apiKey ? "yes" : "no"}`,
        );
      }

      if (!context.allowNetwork || !apiKey || (!context.force && fresh)) {
        return cached.map(toModel);
      }

      try {
        if (process.env.ANYMODEL_DEBUG)
          console.error("[anymodel] fetchModels: fetching /v1/models");
        const payload = await fetchCatalogPayload(apiKey, context.signal);
        const models = parseCatalog(payload);
        if (process.env.ANYMODEL_DEBUG)
          console.error(`[anymodel] fetchModels: got ${models.length} chat models`);
        if (models.length === 0) return cached.map(toModel);
        setCatalog(models);
        writeSnapshotPayload(payload);
        loadMediaFromDisk();
        return models.map(toModel);
      } catch (error) {
        if (process.env.ANYMODEL_DEBUG) {
          console.error(
            `[anymodel] fetchModels: error aborted=${context.signal.aborted} ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!context.signal.aborted) {
          console.warn(
            `[anymodel] catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return cached.map(toModel);
      }
    },
    api: openAICompletionsApi(),
  });
}

// ─── Session state ───────────────────────────────────────────────────

function restoreTotals(ctx: ExtensionContext): UsageTotals {
  const totals = emptyTotals();
  let entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  try {
    entries = ctx.sessionManager.getBranch();
  } catch {
    return totals;
  }
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant" || message.provider !== PROVIDER_ID || !message.usage)
      continue;
    // Skip aborted/failed requests that produced no tokens (they are not charged).
    if (requestRawTotal(message.usage) === 0) continue;
    addRequest(totals, message.model, message.usage, coefficientFor(message.model));
  }
  // A resumed session has no meaningful "last request" until the next turn.
  totals.last = undefined;
  return totals;
}

// ─── Footer ──────────────────────────────────────────────────────────

/**
 * Reading any field of a replaced session's ctx throws from the runtime's
 * assertActive(). All asynchronous work checks this before touching ctx again.
 */
function ctxIsUsable(ctx: ExtensionContext): boolean {
  try {
    void ctx.hasUI;
    return true;
  } catch {
    return false;
  }
}

/** Install the custom footer only while an AnyModel model is selected. */
function applyFooter(
  ctx: ExtensionContext,
  state: State,
  model: { provider: string } | undefined = ctx.model,
): void {
  if (ctx.mode !== "tui") return;
  if (state.footerEnabled && model?.provider === PROVIDER_ID) {
    ctx.ui.setFooter(createAnymodelFooter({ context: () => state.context, statusKey: STATUS_KEY }));
  } else {
    ctx.ui.setFooter(undefined);
  }
}

// ─── Status line ─────────────────────────────────────────────────────

function contextStatus(ctx: ExtensionContext): string | undefined {
  if (typeof ctx.getContextUsage !== "function") return undefined;
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  const theme = ctx.ui.theme;
  const window = formatTokens(usage.contextWindow);
  if (usage.percent === null) return theme.fg("dim", `ctx ?/${window}`);
  const text = `ctx ${usage.percent.toFixed(1)}%/${window}`;
  if (usage.percent > 90) return theme.fg("error", text);
  if (usage.percent > 70) return theme.fg("warning", text);
  return theme.fg("dim", text);
}

function renderStatusSafely(ctx: ExtensionContext, state: State): void {
  if (!ctxIsUsable(ctx)) return;
  try {
    renderStatus(ctx, state);
  } catch {
    // The session can be replaced between the check and the read.
  }
}

function renderStatus(ctx: ExtensionContext, state: State): void {
  if (!ctx.hasUI) return;
  // Outside AnyModel the built-in footer owns the status row and already shows
  // context usage, so this status must stay silent.
  if (ctx.model?.provider !== PROVIDER_ID) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const totals = state.totals;
  const spent = `${totals.unknownCoefficient > 0 ? "≥" : ""}${formatTokens(totals.billed)}`;

  // Counters and balance are shown from the start (zeros until the first
  // request lands), so the footer never collapses to context alone.
  const segments: string[] = [
    theme.fg("dim", `↑${formatTokens(totals.rawPrompt)}`),
    theme.fg("dim", `↓${formatTokens(totals.output)}`),
    theme.fg("accent", `${spent} btok`),
  ];
  if (state.balance) {
    segments.push(
      theme.fg(
        state.balance.unlimited ? "success" : "warning",
        state.balance.unlimited ? "∞" : `${formatTokens(state.balance.balance)} left`,
      ),
    );
  }

  const context = contextStatus(ctx);
  if (context) segments.push(context);

  const body = segments.join(theme.fg("dim", " · "));
  ctx.ui.setStatus(STATUS_KEY, `${theme.fg("accent", "AM")} ${body}`);
}

// ─── Balance ─────────────────────────────────────────────────────────

/**
 * Force a model-catalog refresh. Used on startup and by `/anymodel refresh`.
 *
 * pi's model runtime coalesces refreshes per provider and aborts an in-flight
 * one when a newer refresh starts, so a cache-only refresh during startup can
 * cancel our network fetch. A private signal keeps the dispatch from aborting
 * it, and the snapshot check retries until the fetch actually lands.
 */
async function refreshCatalog(ctx: ExtensionContext, state: State): Promise<boolean> {
  if (!ctxIsUsable(ctx)) return false;
  const apiKey = await resolveApiKey(ctx);
  if (!apiKey) {
    debugLog("refreshCatalog: no API key, using cached models");
    return false;
  }

  let fetched = false;
  try {
    for (let attempt = 0; attempt < CATALOG_REFRESH_ATTEMPTS; attempt++) {
      if (!ctxIsUsable(ctx)) {
        debugLog("refreshCatalog: session replaced, stopping");
        break;
      }
      if (attempt > 0) await delay(CATALOG_REFRESH_RETRY_MS * attempt);
      const before = snapshotAgeMs();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
      try {
        const result = await ctx.modelRegistry.refresh({
          providers: [PROVIDER_ID],
          force: true,
          signal: controller.signal,
        });
        const error = result.errors.get(PROVIDER_ID);
        if (error) {
          console.warn(`[anymodel] catalog refresh failed: ${error.message}`);
          break;
        }
      } catch (error) {
        if (!ctxIsUsable(ctx)) {
          debugLog("refreshCatalog: session replaced while refreshing");
          break;
        }
        console.warn(
          `[anymodel] catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      } finally {
        clearTimeout(timeout);
      }

      const after = snapshotAgeMs();
      fetched = before === undefined || after === undefined || after < before;
      if (fetched) {
        debugLog(`refreshCatalog: fetched catalog (attempt ${attempt + 1})`);
        break;
      }
      debugLog(`refreshCatalog: attempt ${attempt + 1} was superseded`);
    }
  } catch (error) {
    debugLog(`refreshCatalog: aborted (${error instanceof Error ? error.message : String(error)})`);
    return false;
  } finally {
    renderStatusSafely(ctx, state);
  }
  return fetched;
}

function debugLog(message: string): void {
  if (process.env.ANYMODEL_DEBUG) console.error(`[anymodel] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  try {
    const key = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
    if (key) return key;
  } catch {
    // Fall through to the environment.
  }
  for (const name of ENV_VARS) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Refresh the account balance, coalescing calls: while a request is in flight
 * later calls only schedule one follow-up, so a tool-heavy turn cannot start a
 * burst of parallel requests.
 */
async function scheduleBalanceRefresh(ctx: ExtensionContext, state: State): Promise<void> {
  if (state.balanceRefreshing) {
    state.balanceQueued = true;
    return;
  }
  state.balanceRefreshing = true;
  try {
    do {
      state.balanceQueued = false;
      await refreshBalance(ctx, state);
      renderStatusSafely(ctx, state);
    } while (state.balanceQueued && ctxIsUsable(ctx));
  } finally {
    state.balanceRefreshing = false;
  }
}

async function refreshBalance(ctx: ExtensionContext, state: State): Promise<Balance | undefined> {
  if (!ctxIsUsable(ctx)) return undefined;
  const apiKey = await resolveApiKey(ctx);
  if (!apiKey) return undefined;
  try {
    const response = await fetch(`${BASE_URL}/balance`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: withTimeout(ctx.signal, BALANCE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    if (typeof payload.balance !== "number") throw new Error("unexpected response");
    state.balance = {
      balance: payload.balance,
      unlimited: payload.unlimited === true,
      status: typeof payload.status === "string" ? payload.status : "unknown",
      fetchedAt: Date.now(),
    };
    return state.balance;
  } catch (error) {
    console.warn(
      `[anymodel] balance request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

// ─── Command ─────────────────────────────────────────────────────────

async function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: State,
  pi: ExtensionAPI,
): Promise<void> {
  const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);

  switch (subcommand) {
    case "": {
      await ctx.waitForIdle?.();
      await refreshBalance(ctx, state);
      renderStatus(ctx, state);
      ctx.ui.notify(usageReport(ctx, state), "info");
      return;
    }

    case "refresh": {
      const fetched = await refreshCatalog(ctx, state);
      const count = getCatalog().length;
      if (fetched) {
        ctx.ui.notify(`AnyModel catalog refreshed: ${count} models.`, "info");
      } else {
        ctx.ui.notify(
          `Catalog not refreshed (no key, offline, or the refresh was superseded). Cached: ${count} models.`,
          "warning",
        );
      }
      return;
    }

    case "footer": {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The custom footer is only available in the interactive TUI.", "warning");
        return;
      }
      const arg = rest[0]?.toLowerCase();
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /anymodel footer on|off", "warning");
        return;
      }
      state.footerEnabled = arg === "on";
      applyFooter(ctx, state);
      ctx.ui.notify(
        state.footerEnabled
          ? "Custom footer enabled for AnyModel models (other providers keep pi's footer)."
          : "Built-in pi footer restored.",
        "info",
      );
      return;
    }

    case "image":
      await runImageCommand(rest.join(" "), ctx, pi, state);
      return;

    default:
      ctx.ui.notify("Usage: /anymodel [image <prompt>|refresh|footer on|off]", "warning");
      return;
  }
}

function usageReport(ctx: ExtensionContext, state: State): string {
  const current = ctx.model?.provider === PROVIDER_ID ? ctx.model : undefined;
  const totals = state.totals;
  const lines: string[] = ["AnyModel · session usage"];

  lines.push(
    current
      ? `Model:      ${current.id} (coef ${describeCoefficient(coefficientFor(current.id))})`
      : "Model:      not AnyModel",
  );

  lines.push(`Requests:   ${formatExact(totals.requests)}`);
  lines.push(
    `Input:      ${formatExact(totals.rawPrompt)} tokens (cache read ${formatExact(totals.cacheRead)}, write ${formatExact(totals.cacheWrite)})`,
  );
  lines.push(`Output:     ${formatExact(totals.output)} tokens`);
  lines.push(`Total:      ${formatExact(totals.rawTotal)} tokens`);

  const bound = totals.unknownCoefficient > 0 ? "≥" : "";
  lines.push(
    `Billed:     ${bound}${formatExact(totals.billed)} btok (${formatTokens(totals.billed)})` +
      (totals.unknownCoefficient > 0 ? ` · ${totals.unknownCoefficient} without coefficient` : ""),
  );
  if (totals.mediaRequests > 0) {
    lines.push(
      `Media:      ${formatExact(totals.mediaRequests)} generation(s) · ${formatExact(totals.mediaBilled)} btok`,
    );
  }

  if (totals.last) {
    const last = totals.last;
    const billed = last.billed === undefined ? "?" : formatExact(last.billed);
    lines.push(
      `Last:       ${last.model}: ↑${formatExact(last.rawPrompt)} (cache ${formatExact(last.cacheRead)}) ↓${formatExact(last.output)} → ${billed} btok`,
    );
  }

  const top = topModels(totals, 3);
  if (top.length > 1) {
    lines.push("By model:");
    for (const entry of top) {
      const boundModel = entry.totals.unknownCoefficient > 0 ? "≥" : "";
      lines.push(
        `  ${entry.id}: ${boundModel}${formatExact(entry.totals.billed)} btok · ${formatExact(entry.totals.rawTotal)} tokens`,
      );
    }
  }

  const balance = state.balance;
  if (balance) {
    lines.push(
      balance.unlimited
        ? `Balance:    unlimited · status ${balance.status}`
        : `Balance:    ${formatExact(balance.balance)} btok (${formatTokens(balance.balance)}) · status ${balance.status}`,
    );
  } else {
    lines.push("Balance:    unknown (run /login → AnyModel)");
  }

  if (current && !getCatalogModel(current.id)) {
    lines.push("Note:       model not in catalog, spend may be undercounted.");
  }

  return lines.join("\n");
}

// ─── Media: tools, renderer, command ───────────────────────────────

interface ImageToolDetails {
  model: string;
  billed: number;
  files: { path: string; mimeType: string; bytes: number }[];
  revisedPrompts: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** pi only renders tool-result images when the terminal reports a protocol. */
function inlineImagesSupported(): boolean {
  try {
    return Boolean(getCapabilities().images);
  } catch {
    return false;
  }
}

const NO_INLINE_IMAGES_HINT =
  '\nNote: this terminal reports no inline-image support, so no preview is shown. Open the file above, or set terminal.images ("kitty" | "iterm2") or PI_IMAGE_PROTOCOL to override detection.';

/** Charge the session totals and keep the footer's balance fresh. */
function accountMediaSpend(
  ctx: ExtensionContext,
  state: State,
  modelId: string,
  billed: number,
): void {
  addMediaSpend(state.totals, modelId, billed);
  renderStatusSafely(ctx, state);
  void scheduleBalanceRefresh(ctx, state);
}

async function resolveMediaKey(ctx: ExtensionContext): Promise<string> {
  const key = await resolveApiKey(ctx);
  if (!key)
    throw new Error('AnyModel API key is not configured. Run /login and pick "AnyModel API key".');
  return key;
}

/** Cheapest unit price of an image model, for picking a default. */
function mediaUnitCost(model: MediaModel): number {
  return (model.baseTokens ?? 0) * (model.coefficient?.output ?? 1);
}

function pickImageModel(requested: string | undefined): string {
  if (requested) return requested;
  const models = getMediaModels("image");
  if (models.length === 0)
    throw new Error("No AnyModel image models are known yet. Run /anymodel refresh.");
  return [...models].sort((a, b) => mediaUnitCost(a) - mediaUnitCost(b))[0].id;
}

function parseMediaArgs(args: string): { prompt: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const words: string[] = [];
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/u.exec(token);
    if (match) flags[match[1].toLowerCase()] = match[2] ?? "true";
    else words.push(token);
  }
  return { prompt: words.join(" "), flags };
}

function numberFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function imageToolResult(outcome: {
  model: { id: string };
  billed: number;
  files: { path: string; mimeType: string; bytes: number; data: string }[];
  revisedPrompts: string[];
}): AgentToolResult<ImageToolDetails> {
  const text =
    `Generated ${outcome.files.length} image(s) with ${outcome.model.id} for ${formatExact(outcome.billed)} btok.\nSaved to:\n${outcome.files.map((file) => file.path).join("\n")}` +
    (inlineImagesSupported() ? "" : NO_INLINE_IMAGES_HINT);
  return {
    content: [
      { type: "text" as const, text },
      ...outcome.files.map((file) => ({
        type: "image" as const,
        data: file.data,
        mimeType: file.mimeType,
      })),
    ],
    details: {
      model: outcome.model.id,
      billed: outcome.billed,
      files: outcome.files.map(({ path, mimeType, bytes }) => ({ path, mimeType, bytes })),
      revisedPrompts: outcome.revisedPrompts,
    },
  };
}

function registerImageTool(pi: ExtensionAPI, state: State): void {
  pi.registerTool({
    name: "anymodel_image",
    label: "AnyModel Image",
    description:
      "Generate images with AnyModel and save them to disk. Returns the file paths and attaches the images. Pass `model` to pick a specific AnyModel image model; otherwise the cheapest one is used. Costs balance tokens (btok), not USD.",
    promptSnippet: "Generate images with AnyModel",
    parameters: Type.Object({
      prompt: Type.String({ description: "What to generate" }),
      model: Type.Optional(
        Type.String({ description: "AnyModel image model id, e.g. am/flux.2-klein-4b" }),
      ),
      n: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_IMAGES,
          description: `Images to generate (1-${MAX_IMAGES})`,
        }),
      ),
      size: Type.Optional(Type.String({ description: 'e.g. "1024x1024", "1792x1024"' })),
      quality: Type.Optional(Type.String({ description: 'e.g. "low", "medium", "high"' })),
      outputFormat: Type.Optional(Type.String({ description: "png, jpeg or webp" })),
    }),
    execute: async (
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<ImageToolDetails>> => {
      const apiKey = await resolveMediaKey(ctx);
      const model = pickImageModel(params.model);
      const outcome = await generateImages(
        apiKey,
        {
          model,
          prompt: params.prompt,
          n: params.n,
          size: params.size,
          quality: params.quality,
          outputFormat: params.outputFormat,
        },
        signal,
      );
      accountMediaSpend(ctx, state, outcome.model.id, outcome.billed);
      return imageToolResult(outcome);
    },
  });
}

/** Renders the command's custom message: text plus the generated PNGs. */
function registerMediaRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("anymodel-media", (message, _options, theme) => {
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const children: Component[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        children.push(new Text(theme.fg("customMessageText", block.text)));
      } else if (block.mimeType === "image/png") {
        // Only PNG: other formats would need a transcoder, and the command
        // sends a converted PNG preview.
        try {
          children.push(
            new Image(
              block.data,
              block.mimeType,
              { fallbackColor: (text: string) => theme.fg("muted", text) },
              { maxWidthCells: 60 },
            ),
          );
        } catch {
          children.push(new Text(theme.fg("muted", `[image ${block.mimeType}]`)));
        }
      }
    }
    return {
      invalidate: () => {
        for (const child of children) child.invalidate();
      },
      render: (width: number) => {
        try {
          return children.flatMap((child) => child.render(width));
        } catch {
          // A rendering failure must never break the whole transcript.
          return [];
        }
      },
    };
  });
}

async function runImageCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  state: State,
): Promise<void> {
  const { prompt, flags } = parseMediaArgs(args);
  if (!prompt) {
    ctx.ui.notify(
      "Usage: /anymodel image <prompt> [--model=id] [--n=1] [--size=1024x1024] [--quality=medium] [--format=png]",
      "warning",
    );
    return;
  }

  let apiKey: string;
  try {
    apiKey = await resolveMediaKey(ctx);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "warning");
    return;
  }

  try {
    const model = pickImageModel(flags.model);
    const outcome = await generateImages(
      apiKey,
      {
        model,
        prompt,
        n: numberFlag(flags.n),
        size: flags.size,
        quality: flags.quality,
        outputFormat: flags.format,
      },
      ctx.signal,
    );
    accountMediaSpend(ctx, state, outcome.model.id, outcome.billed);
    ctx.ui.notify(
      `Image(s) saved: ${outcome.files.map((file) => file.path).join(", ")} · ${formatExact(outcome.billed)} btok` +
        (inlineImagesSupported() ? "" : " · no inline preview in this terminal"),
      "info",
    );
    pi.sendMessage({
      customType: "anymodel-media",
      content: [
        {
          type: "text" as const,
          text: `AnyModel image · ${outcome.model.id} · ${formatExact(outcome.billed)} btok\n${outcome.files.map((file) => file.path).join("\n")}`,
        },
        ...outcome.files.map((file) => ({
          type: "image" as const,
          data: file.previewData,
          mimeType: file.previewMimeType,
        })),
      ],
      display: true,
      details: {
        model: outcome.model.id,
        billed: outcome.billed,
        files: outcome.files.map(({ path, mimeType, bytes }) => ({ path, mimeType, bytes })),
      },
    });
  } catch (error) {
    ctx.ui.notify(`Generation failed: ${errorMessage(error)}`, "error");
  }
}
