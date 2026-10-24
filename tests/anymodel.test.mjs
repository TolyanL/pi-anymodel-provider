/**
 * Development test harness for pi-anymodel-provider. Not loaded by pi: extension
 * discovery uses the root index.ts and .mjs files are not extension candidates.
 *
 * Run: node tests/anymodel.test.mjs
 *
 * Requires the pi install path (override with PI_PACKAGE) and a catalog
 * snapshot at the agent dir.
 */

const PI = process.env.PI_PACKAGE ?? "/home/tolyan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// jiti ships with pi; load it via an absolute path so the harness needs no
// local package.json.
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);

const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
    "@earendil-works/pi-ai/compat": `${PI}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
    "@earendil-works/pi-ai": `${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`,
    "@earendil-works/pi-tui": `${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  },
});

delete process.env.ANYMODEL_API_KEY;
delete process.env.ANYMODEL_KEY;

// Sandbox the agent dir: media files and snapshots must never land in the real one.
const { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
const { join, resolve } = await import("node:path");
const REAL_AGENT = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "/root", ".pi/agent");
const TEST_AGENT = "/tmp/anymodel-test-agent";
mkdirSync(TEST_AGENT, { recursive: true });
try {
  copyFileSync(join(REAL_AGENT, "anymodel-catalog.json"), join(TEST_AGENT, "anymodel-catalog.json"));
} catch {
  // the harness needs a snapshot; it exits below when it is missing
}
process.env.PI_CODING_AGENT_DIR = TEST_AGENT;

const catalog = await jiti.import(`${here}/catalog.ts`);
const billing = await jiti.import(`${here}/billing.ts`);
const footer = await jiti.import(`${here}/footer.ts`);
const media = await jiti.import(`${here}/media.ts`);
const config = await jiti.import(`${here}/config.ts`);
const extension = await jiti.import(`${here}/index.ts`, { default: true });

let failures = 0;
const check = (name, actual, expected) => {
  const okResult = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okResult) {
    failures++;
    console.log(`FAIL ${name}:\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`);
  } else console.log(`ok   ${name}`);
};
const contains = (name, haystack, needle) => check(name, String(haystack).includes(needle), true);
const ok = (name, cond) => check(name, !!cond, true);

const payload = catalog.readSnapshotPayload();
if (!payload) {
  console.error("No catalog snapshot. Run pi once with the extension, or /anymodel refresh.");
  process.exit(2);
}
const CHAT_KINDS = new Set(["llm", "chat", "text", "imageToText", "image-to-text"]);
const rawChat = payload.data.filter((m) => m.kind === undefined || CHAT_KINDS.has(m.kind));
const models = catalog.parseCatalog(payload);

// ─── catalog ─────────────────────────────────────────────────────────
check("parseCatalog keeps chat kinds only", models.length, rawChat.length);
ok("parseCatalog returns models", models.length > 0);
check("image kinds dropped", models.some((m) => m.kind === "image"), false);
check("no duplicate ids", new Set(models.map((m) => m.id)).size, models.length);
check("garbage payload", catalog.parseCatalog({ nope: true }), []);
check("defensive payload", catalog.parseCatalog({ data: [null, 5, { id: "" }, { id: "x", kind: "video" }] }).length, 0);

for (const raw of rawChat.slice(0, 5)) {
  const parsed = models.find((m) => m.id === raw.id);
  const coef = raw.billing?.coefficient;
  if (coef) check(`coefficient ${raw.id}`, parsed.coefficient, { input: coef.input, output: coef.output });
  const caps = raw.capabilities ?? {};
  check(`vision ${raw.id}`, parsed.vision, caps.vision === true);
  if (caps.contextWindow) check(`contextWindow ${raw.id}`, parsed.contextWindow, caps.contextWindow);
  if (caps.maxOutput) check(`maxTokens ${raw.id}`, parsed.maxTokens, Math.min(caps.maxOutput, parsed.contextWindow));
}

const expectedFormat = { deepseek: "deepseek", zai: "zai", qwen: "qwen" };
for (const [source, mapped] of Object.entries(expectedFormat)) {
  const model = models.find((m) => m.thinkingFormat === source);
  if (model) check(`thinkingFormat ${source}`, catalog.toModel(model).compat?.thinkingFormat, mapped);
}
const nonDisable = models.find((m) => m.reasoning && m.thinkingCanDisable === false);
if (nonDisable) check("thinkingCanDisable=false -> off null", catalog.toModel(nonDisable).thinkingLevelMap, { off: null });

const built = catalog.toModel(models[0]);
check("toModel provider/api", [built.provider, built.api], ["anymodel", "openai-completions"]);
check("toModel zero USD cost", built.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// ─── billing ─────────────────────────────────────────────────────────
check("doc example billed", billing.billedFor({ input: 3, output: 3 }, { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0 }), 36000);
check("cache counts toward the prompt", billing.billedFor({ input: 1, output: 2 }, { input: 9000, output: 1000, cacheRead: 1000, cacheWrite: 0 }), 12000);
check("free route", billing.billedFor({ input: 0, output: 0 }, { input: 5_000_000, output: 10_000, cacheRead: 0, cacheWrite: 0 }), 0);
check("minimum one btok", billing.billedFor({ input: 0.05, output: 0.05 }, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), 1);
check("unknown coefficient", billing.billedFor(undefined, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
check("formatTokens 12.2k", billing.formatTokens(12200), "12.2k");
check("formatTokens 36k", billing.formatTokens(36000), "36k");
check("formatTokens 10.7M", billing.formatTokens(10694846), "10.7M");
check("describeCoefficient unknown", billing.describeCoefficient(undefined), "unknown (combo route)");
check("describeCoefficient free", billing.describeCoefficient({ input: 0, output: 0 }), "×0 (free)");
check("describeCoefficient split", billing.describeCoefficient({ input: 3, output: 4 }), "in ×3 / out ×4");

// ─── footer ──────────────────────────────────────────────────────────
const plainTheme = { fg: (_c, t) => t };
const stripAnsi = (l) => l.replace(/\x1B\[[0-9;]*m/g, "");
const makeData = (statuses = [["mcp", "mcp 3/3"], ["pi-anymodel", "AM ↑1k ↓2k"]], providers = 1) => ({
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map(statuses),
  getAvailableProviderCount: () => providers,
  onBranchChange: () => () => {},
});
const makeFooterCtx = (over = {}) => ({
  mode: "tui",
  model: { id: "glm/glm-5.3", provider: "anymodel", reasoning: true },
  thinkingLevel: "high",
  sessionManager: { getCwd: () => `${process.env.HOME}/proj`, getSessionName: () => "demo" },
  getContextUsage: () => ({ tokens: 1, contextWindow: 200000, percent: 56.8 }),
  ...over,
});
const renderFooter = (width, ctx = makeFooterCtx(), data = makeData()) =>
  footer.renderFooter(width, plainTheme, data, { context: () => ctx, statusKey: "pi-anymodel" });

{
  const lines = renderFooter(80);
  check("footer line count", lines.length, 3);
  check("footer pwd row", lines[0], "~/proj (main) • demo");
  check("stats left, model right", [lines[1].startsWith("AM ↑1k ↓2k"), lines[1].endsWith("glm/glm-5.3 • high")], [true, true]);
  check("statuses on the row below", lines[2], "mcp 3/3");
  check("no built-in cache stat", lines.some((l) => l.includes("CH")), false);
}
{
  const lines = renderFooter(80, makeFooterCtx(), makeData([["mcp", "x"]]));
  check("model right-aligned without our stats", [lines[1].startsWith(" "), lines[1].endsWith("glm/glm-5.3 • high")], [true, true]);
  check("mcp below without our stats", lines[2], "x");
}
{
  const lines = renderFooter(20);
  check("footer truncation fits width", lines.every((l) => stripAnsi(l).length <= 20), true);
}

// ─── functional ──────────────────────────────────────────────────────
function buildExt() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  const renderers = new Map();
  const pi = {
    registerProvider: () => {},
    registerCommand: (name, opts) => commands.set(name, opts),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
    sendMessage: (message) => messages.push(message),
    on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    events: {},
  };
  extension(pi);
  return { handlers, commands, tools, messages, renderers };
}

function makeCtx({ model = { id: "test/model", provider: "anymodel" }, branch = [], apiKey = undefined } = {}) {
  const statuses = [];
  const notices = [];
  const footers = [];
  const refreshCalls = [];
  return {
    hasUI: true,
    model,
    sessionManager: {
      getBranch: () => branch,
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    modelRegistry: {
      getApiKeyForProvider: async () => apiKey,
      refresh: async (options) => { refreshCalls.push(options); return { errors: new Map(), aborted: false }; },
    },
    waitForIdle: async () => {},
    ui: {
      theme: { fg: (color, text) => `<${color}>${text}</>` },
      setStatus: (key, value) => statuses.push([key, value]),
      setFooter: (factory) => footers.push(factory),
      notify: (message, type) => notices.push([type, message]),
    },
    statuses,
    notices,
    footers,
    refreshCalls,
  };
}

const testModel = models.find((m) => m.coefficient && m.coefficient.input === 1 && m.coefficient.output === 1) ?? models[0];
const testCoef = testModel.coefficient;
const expectedBilled = testCoef ? Math.max(1, Math.ceil(10000 * testCoef.input + 2000 * testCoef.output)) : undefined;
const usage = { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 12000 };
const assistant = (over = {}) => ({
  role: "assistant", provider: "anymodel", model: testModel.id, usage, stopReason: "stop", ...over,
});

// accounting + status format
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" } });
  await handlers.get("message_end")[0]({ type: "message_end", message: assistant() }, ctx);
  const status = ctx.statuses.at(-1);
  check("status key", status[0], "pi-anymodel");
  contains("status has AM prefix", status[1], "AM");
  contains("status has upstream arrow", status[1], `↑${billing.formatTokens(10000)}`);
  contains("status has downstream arrow", status[1], `↓${billing.formatTokens(2000)}`);
  if (expectedBilled !== undefined) contains("status has btok spend", status[1], `${billing.formatTokens(expectedBilled)} btok`);
}

// outside anymodel: status silent
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: "gpt", provider: "commandcode" } });
  ctx.getContextUsage = () => ({ tokens: 9, contextWindow: 10, percent: 95 });
  await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
  check("status cleared outside anymodel", ctx.statuses.at(-1)[1], undefined);
}

// anymodel without requests: zero counters + context, never context alone
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" } });
  ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 200000, percent: 56.8 });
  await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
  const status = ctx.statuses.at(-1)[1].replace(/<\/?[a-z]*>/g, "");
  contains("zero counters shown at start", status, "AM ↑0 · ↓0 · 0 btok");
  contains("context percent/window shown", status, "ctx 56.8%/200k");
}

// balance appears before the first request
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" }, apiKey: "test-key" });
  ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 200000, percent: 56.8 });
  ctx.modelRegistry.refresh = async () => { catalog.setCatalog(catalog.getCatalog(), Date.now()); return { errors: new Map(), aborted: false }; };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ balance: 9840000, unlimited: false, status: "active" }) });
  try {
    await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    globalThis.fetch = realFetch;
  }
  contains("balance shown before first request", ctx.statuses.at(-1)[1], "9.84M left");
}

// context threshold coloring
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" } });
  ctx.getContextUsage = () => ({ tokens: 9, contextWindow: 10, percent: 95 });
  await handlers.get("message_end")[0]({ type: "message_end", message: assistant() }, ctx);
  contains("high context colored as error", ctx.statuses.at(-1)[1], "error");
}

// footer follows the selected model
{
  const { handlers } = buildExt();
  const other = makeCtx({ model: { id: "gpt", provider: "commandcode" } });
  other.mode = "tui";
  await handlers.get("session_start")[0]({ type: "session_start" }, other);
  check("no custom footer for other providers", other.footers.at(-1), undefined);

  const mine = makeCtx({ model: { id: testModel.id, provider: "anymodel" } });
  mine.mode = "tui";
  mine.getContextUsage = () => ({ tokens: 1, contextWindow: 2, percent: 50 });
  await handlers.get("model_select")[0]({ type: "model_select", model: { id: testModel.id, provider: "anymodel" } }, mine);
  check("custom footer installed for anymodel", typeof mine.footers.at(-1), "function");

  const back = makeCtx({ model: { id: "gpt", provider: "commandcode" } });
  back.mode = "tui";
  await handlers.get("model_select")[0]({ type: "model_select", model: { id: "gpt", provider: "commandcode" } }, back);
  check("built-in footer restored when switching away", back.footers.at(-1), undefined);

  await handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, mine);
  check("built-in footer restored on shutdown", mine.footers.at(-1), undefined);
}

// startup refresh
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" }, apiKey: "test-key" });
  const calls = [];
  let complete;
  ctx.modelRegistry.refresh = (options) => {
    calls.push(options);
    return new Promise((resolve) => {
      complete = () => { catalog.setCatalog(catalog.getCatalog(), Date.now()); resolve({ errors: new Map(), aborted: false }); };
    });
  };
  await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
  await new Promise((r) => setTimeout(r, 0));
  const realFetchStartup = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ balance: 1, unlimited: false, status: "active" }) });
  check("startup refresh does not block", calls.length, 1);
  check("startup refresh still pending", typeof complete, "function");
  check("startup refresh targets anymodel with force", [calls[0].providers, calls[0].force], [["anymodel"], true]);
  complete();
  await new Promise((r) => setTimeout(r, 20));
  await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
  await new Promise((r) => setTimeout(r, 0));
  check("startup refresh once per instance", calls.length, 1);
  await new Promise((r) => setTimeout(r, 30));
  globalThis.fetch = realFetchStartup;
}

// superseded refresh retried
{
  const { commands } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" }, apiKey: "test-key" });
  let calls = 0;
  ctx.modelRegistry.refresh = async () => {
    calls++;
    if (calls === 2) catalog.setCatalog(catalog.getCatalog(), Date.now());
    return { errors: new Map(), aborted: false };
  };
  await commands.get("anymodel").handler("refresh", ctx);
  check("refresh retried after supersede", calls, 2);
  contains("refresh reports success", ctx.notices.at(-1)[1], "refreshed:");
}

// balance refreshes after every assistant message, coalescing bursts
{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" }, apiKey: "test-key" });
  let fetches = 0;
  let authHeader;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    fetches++;
    authHeader = options?.headers?.Authorization;
    return { ok: true, json: async () => ({ balance: 9840000, unlimited: false, status: "active" }) };
  };
  try {
    await handlers.get("message_end")[0]({ type: "message_end", message: assistant() }, ctx);
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    globalThis.fetch = realFetch;
  }
  ok("balance fetched after a message", fetches >= 1);
  check("balance uses bearer key", authHeader, "Bearer test-key");
  contains("status shows refreshed balance", ctx.statuses.at(-1)[1], "9.84M left");
}

{
  const { handlers } = buildExt();
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" }, apiKey: "test-key" });
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    await new Promise((r) => setTimeout(r, 60));
    return { ok: true, json: async () => ({ balance: 1000, unlimited: false, status: "active" }) };
  };
  try {
    const onMessage = handlers.get("message_end")[0];
    await onMessage({ type: "message_end", message: assistant() }, ctx);
    await onMessage({ type: "message_end", message: assistant() }, ctx);
    await onMessage({ type: "message_end", message: assistant() }, ctx);
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    globalThis.fetch = realFetch;
  }
  check("rapid messages coalesce balance fetches", fetches, 2);
}

// report + zero-usage skip
{
  const { handlers, commands } = buildExt();
  const branch = [
    { type: "message", id: "1", parentId: null, timestamp: "t", message: assistant() },
    { type: "message", id: "2", parentId: "1", timestamp: "t", message: assistant({ model: "combo/x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "aborted" }) },
  ];
  const ctx = makeCtx({ model: { id: testModel.id, provider: "anymodel" }, branch });
  await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
  await commands.get("anymodel").handler("", ctx);
  const report = ctx.notices.at(-1)[1];
  contains("report header", report, "AnyModel · session usage");
  contains("report skips zero-usage requests", report, "Requests:   1\n");
  contains("report totals", report, "Total:      12,000 tokens");
  contains("report balance unknown", report, "Balance:    unknown");
  check("report has no explanatory fluff", report.includes("the cabinet"), false);
}

// ─── config: output directory ────────────────────────────────────────
const CONFIG_FILE = config.configPath();
{
  rmSync(CONFIG_FILE, { force: true });
  check("config path lives in the agent dir", CONFIG_FILE, join(TEST_AGENT, "anymodel.json"));
  check("default media dir without a config", media.mediaDir(), config.defaultMediaDir());

  const custom = join(TEST_AGENT, "pictures");
  writeFileSync(CONFIG_FILE, JSON.stringify({ output: custom }));
  check("output from the config is honored", media.mediaDir(), custom);

  writeFileSync(CONFIG_FILE, JSON.stringify({ output: "~/anymodel-pics" }));
  check("~ expands to the home directory", media.mediaDir(), join(process.env.HOME, "anymodel-pics"));

  writeFileSync(CONFIG_FILE, JSON.stringify({ output: "./relative-pics" }));
  check("relative output resolves against cwd", media.mediaDir(), resolve("./relative-pics"));

  writeFileSync(CONFIG_FILE, "");
  check("an empty config is treated as no config", media.mediaDir(), config.defaultMediaDir());

  writeFileSync(CONFIG_FILE, "{ not json");
  check("malformed config falls back to the default", media.mediaDir(), config.defaultMediaDir());

  writeFileSync(CONFIG_FILE, JSON.stringify({ output: 42 }));
  check("wrong output type falls back to the default", media.mediaDir(), config.defaultMediaDir());

  writeFileSync(CONFIG_FILE, JSON.stringify({ mediaDir: join(TEST_AGENT, "legacy") }));
  check("the removed mediaDir key is ignored", media.mediaDir(), config.defaultMediaDir());

  rmSync(CONFIG_FILE, { force: true });
  check("removing the config restores the default", media.mediaDir(), config.defaultMediaDir());

  const altConfig = join(TEST_AGENT, "alt-anymodel.json");
  writeFileSync(altConfig, JSON.stringify({ output: join(TEST_AGENT, "alt-media") }));
  process.env.PI_ANYMODEL_CONFIG = altConfig;
  check("PI_ANYMODEL_CONFIG overrides the config path", media.mediaDir(), join(TEST_AGENT, "alt-media"));
  delete process.env.PI_ANYMODEL_CONFIG;
  rmSync(altConfig, { force: true });
}

// ─── media: catalog, pricing, generation, tool, command ─────────────
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
// 1x1 JPEG: the free FLUX routes return JPEG, which must still preview.
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const imageModel = {
  id: "test/image-model",
  name: "Test Image",
  kind: "image",
  ownedBy: "test",
  unit: "image",
  baseTokens: 100000,
  scales: { quality: { low: 0.25, medium: 1, high: 4 }, size: { "1024x1024": 1, "1792x1024": 1.75 } },
  coefficient: { input: 2, output: 2 },
};
catalog.setMediaModels([...catalog.getMediaModels(), imageModel]);

ok("image models parsed from the snapshot", catalog.getMediaModels("image").length > 0);
check("media parsing drops chat entries", catalog.parseMediaModels({ data: [{ id: "x", billing: {} }] }), []);
check("media parsing drops junk", catalog.parseMediaModels({ data: [null, 3, { id: "y", kind: "image" }] }).length, 1);

check("image cost uses scales", media.estimateImageCost(imageModel, { n: 1, quality: "high", size: "1024x1024" }), 800000);
check("image cost multiplies by n", media.estimateImageCost(imageModel, { n: 2, quality: "high", size: "1024x1024" }), 1600000);
check("image cost defaults multipliers to 1", media.estimateImageCost(imageModel, { n: 1 }), 200000);
check("free media costs nothing", media.estimateImageCost({ ...imageModel, coefficient: { input: 0, output: 0 } }, { n: 1 }), 0);
let scaleThrew = false;
try { media.estimateImageCost(imageModel, { n: 1, quality: "ultra" }); } catch { scaleThrew = true; }
check("unknown quality rejected before spending", scaleThrew, true);

{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined });
    return {
      ok: true,
      headers: new Map(),
      json: async () => ({ data: [{ b64_json: PNG_BASE64 }] }),
      arrayBuffer: async () => Buffer.from(PNG_BASE64, "base64"),
    };
  };
  try {
    const outcome = await media.generateImages("test-key", {
      model: imageModel.id,
      prompt: "a cat",
      n: 1,
      quality: "high",
      size: "1024x1024",
    });
    check("image request hits /images/generations", calls[0].url.endsWith("/images/generations"), true);
    check(
      "image request is explicit",
      [calls[0].body.model, calls[0].body.prompt, calls[0].body.n, calls[0].body.response_format],
      [imageModel.id, "a cat", 1, "b64_json"],
    );
    check("image billed from delivered images", outcome.billed, 800000);
    check("image saved inside the sandbox dir", outcome.files[0].path.startsWith(media.mediaDir()), true);
    check("image bytes written", existsSync(outcome.files[0].path), true);
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const { tools, commands, messages } = buildExt();
  // buildExt() reloads the catalog from disk, which drops the synthetic models.
  catalog.setMediaModels([...catalog.getMediaModels(), imageModel]);
  check("image tool registered", typeof tools.get("anymodel_image")?.execute, "function");
  check("media renderer registered", typeof tools.get("anymodel_image"), "object");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Map(),
    json: async () => ({ data: [{ b64_json: PNG_BASE64 }] }),
    arrayBuffer: async () => Buffer.from(PNG_BASE64, "base64"),
  });

  try {
    const ctx = makeCtx({ apiKey: "test-key", model: { id: testModel.id, provider: "anymodel" } });
    const result = await tools
      .get("anymodel_image")
      .execute("call-1", { prompt: "a cat", model: imageModel.id, quality: "high", size: "1024x1024" }, undefined, undefined, ctx);
    check("tool returns an image block", result.content[1]?.type, "image");
    check("tool reports billed btok", result.details.billed, 800000);
    // headless test env has no image protocol, so the hint must be present
    contains("tool hints when the terminal cannot preview", result.content[0].text, "no inline-image support");
    contains("media spend reaches the status line", ctx.statuses.at(-1)[1], "800k btok");
  } finally {
    globalThis.fetch = realFetch;
  }

  const cmdCtx = makeCtx({ apiKey: "test-key", model: { id: testModel.id, provider: "anymodel" } });
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Map(),
    json: async () => ({ data: [{ b64_json: PNG_BASE64 }] }),
    arrayBuffer: async () => Buffer.from(PNG_BASE64, "base64"),
  });
  try {
    await commands
      .get("anymodel")
      .handler(`image a cat --model=${imageModel.id} --quality=high --size=1024x1024`, cmdCtx);
  } finally {
    globalThis.fetch = realFetch;
  }
  contains("command reports the saved path", cmdCtx.notices.at(-1)[1], "Image(s) saved:");
  check("command posts the image into the transcript", messages.at(-1)?.content?.[1]?.type, "image");
  contains("command message carries the cost", messages.at(-1)?.content?.[0]?.text, "btok");
}

// generated files land in the configured directory
{
  const custom = join(TEST_AGENT, "custom-media");
  writeFileSync(CONFIG_FILE, JSON.stringify({ output: custom }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: new Map(), json: async () => ({ data: [{ b64_json: PNG_BASE64 }] }) });
  try {
    const outcome = await media.generateImages("test-key", {
      model: imageModel.id,
      prompt: "config cat",
      n: 1,
      quality: "low",
      size: "1024x1024",
    });
    ok("image written into the configured dir", outcome.files[0].path.startsWith(custom));
    ok("configured dir was created", existsSync(custom));
  } finally {
    globalThis.fetch = realFetch;
    rmSync(CONFIG_FILE, { force: true });
  }
}

// a JPEG response keeps the original file but previews as PNG
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, headers: new Map(), json: async () => ({ data: [{ b64_json: JPEG_BASE64 }] }) });
  try {
    const outcome = await media.generateImages("test-key", { model: imageModel.id, prompt: "jpeg cat", n: 1 });
    check("jpeg saved with its own extension", outcome.files[0].path.endsWith(".jpg"), true);
    check("jpeg keeps its original mime for the tool result", outcome.files[0].mimeType, "image/jpeg");
    check("jpeg preview is converted to png", outcome.files[0].previewMimeType, "image/png");
    ok("jpeg preview carries data", outcome.files[0].previewData.length > 40);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// the command's custom message renders text plus the image
{
  const { renderers } = buildExt();
  const renderer = renderers.get("anymodel-media");
  check("media message renderer registered", typeof renderer, "function");
  const theme = { fg: (_color, text) => text };
  const component = renderer(
    {
      role: "custom",
      customType: "anymodel-media",
      display: true,
      timestamp: 0,
      content: [
        { type: "text", text: "AnyModel image · test/image-model · 800k btok\n/tmp/anymodel-media/1-cat.png" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ],
    },
    {},
    theme,
  );
  ok("renderer returns a component", typeof component?.render, "function");
  const lines = component.render(60);
  ok("renderer renders lines", lines.length > 0);
  ok("rendered text keeps the file path", lines.join("\n").includes("/tmp/anymodel-media/1-cat.png"));
}

// ─── regression: stale ctx after session replacement/reload ──────────
{
  const staleCtx = { get hasUI() { throw new Error("This extension ctx is stale after session replacement or reload."); } };
  const lines = footer.renderFooter(60, plainTheme, makeData(), { context: () => staleCtx, statusKey: "pi-anymodel" });
  ok("footer survives a stale ctx", Array.isArray(lines) && lines.length >= 1);
  check("stale footer has no cwd", lines[0], "");
  check("stale footer falls back to no-model", lines[1].trimEnd().endsWith("no-model"), true);
}

{
  const { handlers } = buildExt();
  const ctx = makeCtx({ apiKey: "test-key", model: { id: testModel.id, provider: "anymodel" } });
  ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 2, percent: 50 });
  ctx.modelRegistry.refresh = async () => {
    catalog.setCatalog(catalog.getCatalog(), Date.now());
    return { errors: new Map(), aborted: false };
  };

  let stale = false;
  Object.defineProperty(ctx, "hasUI", {
    configurable: true,
    get() {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return true;
    },
  });

  let uncaught = 0;
  let unhandled = 0;
  const onUncaught = () => { uncaught++; };
  const onUnhandled = () => { unhandled++; };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ balance: 1, unlimited: false, status: "active" }) });
  try {
    await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
    stale = true; // runtime replaced the session while refresh/balance are in flight
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    globalThis.fetch = realFetch;
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  }

  check("stale ctx does not crash background work", [uncaught, unhandled], [0, 0]);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
