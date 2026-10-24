/**
 * dsh-theater — 多角色剧场执行器（Host 半，零依赖）
 *
 * 设计约束：本插件以 `link:` 方式装进 profile，运行时解析不到 @deepseek-ai/* 核心包，
 * 因此**不 import 任何核心包**：
 *   - 消息对象按 dsh-llm 的 createUserMessage 形状手工构造（role/content/source/id）
 *   - 工具按 dsh-tools 的 register(definition) 契约手写（parameters 用 JSON Schema）
 *
 * 职责只有三件：建会话、投 cue、绑音色。它不含任何剧本逻辑——
 * 打分、裁决、场记、弹窗都在导演会话（场景剧情）里做。
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "theater";
export const inject = ["tools"];

const HOME = os.homedir();
const PLUGIN_DIR = path.join(HOME, ".dsh", "plugins", "dsh-theater");
const ACTORS_FILE = path.join(PLUGIN_DIR, "actors.json");
const TTS_CONFIG = path.join(HOME, ".dsh", "plugins", "dsh-tts", "config.json");
const VOICES_PY = path.join(HOME, ".dsh", "skills", "roleplay", "scripts", "voices.py");

const DEFAULT_PRESET = "theater-actor";
const DEFAULT_TIMEOUT_MS = 180000;

// ---------- 小工具 ----------

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** 等价于 dsh-llm 的 createUserMessage({content, source})。 */
function userMessage(content, source) {
  const raw = JSON.parse(JSON.stringify({ content, source, role: "user", id: randomUUID() }));
  return deepFreeze(raw);
}

function textBlocks(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

function blocksToText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function sessionIdOf(session, event) {
  if (session && session.id) return String(session.id);
  const data = event && event.data;
  if (data && data.sessionId) return String(data.sessionId);
  return "";
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function actors() {
  const map = readJson(ACTORS_FILE, {});
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

function saveActor(name, record) {
  const map = actors();
  map[name] = record;
  writeJson(ACTORS_FILE, map);
  return map;
}

// ---------- 会话操作 ----------

function agentOptions(ctx) {
  const model = ctx.get("agentDefaultModel");
  const selection = model && typeof model.currentSelection === "function" ? model.currentSelection() : {};
  const options = {};
  if (selection && selection.provider) options.provider = selection.provider;
  if (selection && selection.model) options.model = selection.model;
  return options;
}

function presetSetup(ctx, presetId) {
  const presets = ctx.get("agentPresets");
  if (!presets || !presetId) return { agentPreset: undefined, setup: undefined };
  return {
    agentPreset: presetId,
    setup: async (agentCtx) => {
      const resolved = await presets.resolve(presetId);
      await presets.mount(agentCtx, resolved.id);
    },
  };
}

/** 取到可用的 live agent：优先复用，其次走 sessionController 的正式 resume 通道。 */
async function resolveAgent(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (!agents) throw new Error("agents 服务不可用");
  const live = agents.get(sessionId);
  if (live) return live;

  const controller = ctx.get("sessionController");
  const api = controller && controller.agents;
  if (api && typeof api.resolveAgent === "function") {
    const found = await api.resolveAgent(sessionId);
    if (found && found.agent) return found.agent;
    throw new Error(`唤醒会话失败：${JSON.stringify(found && found.error)}`);
  }

  const record = Object.values(actors()).find((item) => item && item.sessionId === sessionId);
  const composition = presetSetup(ctx, record && record.preset);
  const resumed = await agents.resume({
    resumeSessionId: sessionId,
    agentOptions: agentOptions(ctx),
    ...(composition.setup ? { setup: composition.setup } : {}),
  });
  return resumed.agent;
}

/** 建一个全新的角色会话。 */
async function createActorSession(ctx, { cwd, preset }) {
  const agents = ctx.get("agents");
  if (!agents) throw new Error("agents 服务不可用");
  const sessionId = `session-${randomUUID()}`;
  const presetId = preset || DEFAULT_PRESET;
  const composition = presetSetup(ctx, presetId);

  const controller = ctx.get("sessionController");
  const api = controller && controller.agents;
  if (api && typeof api.claim === "function" && composition.agentPreset) {
    try {
      const agent = await api.claim(sessionId, {
        cwd,
        agentPreset: composition.agentPreset,
        reusable: () => false,
      });
      return { sessionId: String(agent.id), preset: composition.agentPreset, via: "controller", agent };
    } catch (error) {
      // 落到手工创建；不把内部错误抛给用户，只记录在返回里
      const fallback = await manualCreate(ctx, agents, sessionId, cwd, composition);
      return { ...fallback, via: "manual", controllerError: String(error && error.message) };
    }
  }
  return { ...(await manualCreate(ctx, agents, sessionId, cwd, composition)), via: "manual" };
}

async function manualCreate(ctx, agents, sessionId, cwd, composition) {
  const meta = { cwd };
  if (composition.agentPreset) meta.agentPreset = composition.agentPreset;
  const created = await agents.create({
    sessionId,
    agentOptions: agentOptions(ctx),
    meta,
    ...(composition.setup ? { setup: composition.setup } : {}),
  });
  return { sessionId: String(created.agent.id), preset: composition.agentPreset, agent: created.agent };
}

/**
 * 把会话挂进它 cwd 对应的那个工作区（侧边栏的归属靠这个，不是靠 cwd）。
 * 返回挂上的工作区标题；空串＝没对上工作区；失败说明带「挂工作区失败」前缀。
 */
async function attachToWorkspace(ctx, sessionId, cwd) {
  const registry = ctx.get("workspaceRegistry");
  if (!registry || typeof registry.list !== "function") return "";
  const real = (p) => {
    try {
      return fs.realpathSync.native(String(p)).toLowerCase();
    } catch {
      return String(p).toLowerCase();
    }
  };
  const target = real(cwd);
  let workspace;
  try {
    workspace = registry.list().find((item) => real(item.path) === target);
  } catch {
    return "";
  }
  if (!workspace) return "";
  try {
    await workspace.attachSession(sessionId);
    return String(workspace.title || workspace.path || "");
  } catch (error) {
    return `挂工作区失败：${String(error && error.message)}`;
  }
}

/** 用角色名给会话命名（写 session/title 事件，侧边栏直接显示）。失败不阻断建会话。 */
function applySessionTitle(ctx, agent, title) {
  const titles = ctx.get("sessionTitle");
  if (!titles || !agent || !agent.session) return "";
  try {
    const accepted = titles.rename(agent.session, String(title || "").trim());
    return accepted && accepted.title ? String(accepted.title) : "";
  } catch (error) {
    return `命名失败：${String(error && error.message)}`;
  }
}

// ---------- 音色 ----------

function pythonExe() {
  const config = readJson(TTS_CONFIG, {});
  if (config && typeof config.pythonPath === "string" && config.pythonPath.trim()) {
    return config.pythonPath.trim();
  }
  return process.platform === "win32" ? "python" : "python3";
}

function bindVoice(sessionId, voice, lang) {
  return new Promise((resolve, reject) => {
    const args = [VOICES_PY, "bind", "--session", sessionId, "--name", String(voice)];
    if (lang) args.push("--lang", String(lang));
    execFile(
      pythonExe(),
      args,
      {
        encoding: "utf8",
        timeout: 90000,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || "").trim();
          reject(new Error(detail || "音色绑定失败"));
          return;
        }
        resolve(String(stdout || "").trim());
      },
    );
  });
}

// ---------- 自动切会话：GUI 跟随当前说话人 ----------

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "::ffff:7f00:1";
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** 只放行本机 GUI 的请求，拒绝跨站与远程访问。 */
function isAllowed(req) {
  try {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    if (typeof req.headers.host !== "string") return false;
    const hostUrl = new URL("http://" + req.headers.host);
    if (!isLoopbackHostname(hostUrl.hostname)) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJsonResponse(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/** 路由统一入口：校验来源、方法，捕获异常。 */
function guardGet(req, res, handler) {
  if (!isAllowed(req)) {
    writeJsonResponse(res, 403, { error: "forbidden" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    handler(req, res);
  } catch (error) {
    try {
      if (!res.headersSent) writeJsonResponse(res, 500, { error: String(error?.message ?? error) });
      else res.end();
    } catch {
      /* 忽略响应失败 */
    }
  }
}

// ---------- 插件主体 ----------

export function apply(ctx) {
  /** sessionId -> { resolve, reject, timer, buffer, sawStart } */
  const waiters = new Map();

  /** 当前应在 GUI 里聚焦的会话：seq 递增，客户端轮询 /api/dsh-theater/now 跟随。 */
  const nowState = { seq: 0, sessionId: "" };
  /** 导演（剧本）会话 id：由 theater_* 工具调用方反推，用于旁白出完把视图切回场景。 */
  let directorSessionId = "";
  const setNow = (sessionId) => {
    if (!sessionId) return;
    nowState.seq += 1;
    nowState.sessionId = String(sessionId);
  };

  const finish = (sessionId, error) => {
    const waiter = waiters.get(sessionId);
    if (!waiter) return;
    waiters.delete(sessionId);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(waiter.buffer.join("\n\n").trim());
  };

  ctx.on("session/event", (session, event) => {
    try {
      if (!event) return;
      const sessionId = sessionIdOf(session, event);
      if (!sessionId) return;
      // 导演这一回合结束：把视图切回场景会话（旁白在那里），等观测者读。
      if (event.type === "turn/end" && directorSessionId && sessionId === directorSessionId) {
        setNow(directorSessionId);
      }
      const waiter = waiters.get(sessionId);
      if (!waiter) return;

      if (event.type === "turn/start") {
        waiter.sawStart = true;
        return;
      }
      if (event.type === "assistant/message") {
        const data = event.data || {};
        const content = (data.message && data.message.content) || data.content;
        const text = blocksToText(content);
        if (text) waiter.buffer.push(text);
        return;
      }
      if (event.type === "turn/end") {
        // 只有自己这一手开过的回合才算数，避免被上一手的收尾提前唤醒
        if (waiter.sawStart) finish(sessionId, null);
      }
    } catch (error) {
      ctx.logger?.warn?.(`theater: session/event 处理失败：${String(error && error.message)}`);
    }
  });

  // 启动自愈：演员表里的会话若还没挂进工作区，启动后补挂一次（新会话在 theater_open 里当场挂）。
  {
    const timer = setTimeout(() => {
      for (const record of Object.values(actors())) {
        if (!record || !record.sessionId || !record.cwd) continue;
        attachToWorkspace(ctx, record.sessionId, record.cwd).catch(() => {});
      }
    }, 2000);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  async function say(sessionId, text, timeoutMs, focus = false) {
    const agent = await resolveAgent(ctx, sessionId);
    if (waiters.has(sessionId)) throw new Error(`会话 ${sessionId} 正在等待上一手返回`);
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(sessionId, new Error(`等待 ${sessionId} 超时（${limit}ms）`)), limit);
      waiters.set(sessionId, { resolve, reject, timer, buffer: [], sawStart: false });
    });

    try {
      if (focus) setNow(sessionId);
      agent.steer(userMessage(textBlocks(text), { kind: "user" }));
    } catch (error) {
      finish(sessionId, error);
    }
    return await reply;
  }

  /** 在角色会话里弹一张确认卡，等观测者点「继续」或「停」；返回值就是选项标签。 */
  async function askGate(sessionId) {
    const uq = ctx.get("userQuestions");
    if (!uq || typeof uq.ask !== "function") throw new Error("userQuestions 服务不可用");
    const agent = await resolveAgent(ctx, sessionId);
    const result = await uq.ask({
      questions: [
        {
          id: "theater-gate",
          question: "这一手走完了。继续下一手？",
          options: [
            { label: "继续", description: "放行下一手" },
            { label: "停", description: "停在这里" },
          ],
        },
      ],
      agent,
    });
    const answer = (result && Array.isArray(result.answers) && result.answers[0]) || {};
    const selected = Array.isArray(answer.selected) ? answer.selected[0] : "";
    return String(selected || answer.custom || "");
  }

  const textOutput = (schema) => ({
    schema,
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });

  // --- theater_open：建一个角色会话 ---
  ctx.tools.register({
    name: "theater_open",
    description:
      "为某个角色创建独立会话（Phase 3 的『出场即建』）。可选同时绑定音色。返回 sessionId，之后用 theater_say 给它投 cue。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "角色名，用于登记到演员表（如 沈砚）。" },
        cwd: { type: "string", description: "工作区绝对路径；角色会话落在同一工作区里。" },
        preset: { type: "string", description: `会话预设 id，默认 ${DEFAULT_PRESET}。` },
        voice: { type: "string", description: "可选：音色名（来自 GPT-SoVITS 语音库）。" },
        lang: { type: "string", description: "可选：音色语种 zh/ja/en。" },
      },
      required: ["name", "cwd"],
    },
    output: textOutput({
      type: "object",
      additionalProperties: true,
      properties: {
        sessionId: { type: "string" },
        name: { type: "string" },
        preset: { type: "string" },
        voice: { type: "string" },
        workspace: { type: "string" },
      },
    }),
    async execute(args) {
      const created = await createActorSession(ctx, { cwd: args.cwd, preset: args.preset });
      const titleNote = applySessionTitle(ctx, created.agent, args.name);
      const workspaceNote = await attachToWorkspace(ctx, created.sessionId, args.cwd);
      let voiceNote = "";
      if (args.voice) {
        voiceNote = await bindVoice(created.sessionId, args.voice, args.lang).catch((error) => `绑定失败：${error.message}`);
      }
      saveActor(args.name, {
        name: args.name,
        sessionId: created.sessionId,
        preset: created.preset,
        cwd: args.cwd,
        voice: args.voice || null,
        lang: args.lang || null,
        via: created.via,
        createdAt: new Date().toISOString(),
      });
      return {
        sessionId: created.sessionId,
        name: args.name,
        preset: created.preset || "",
        title: String(titleNote).slice(0, 200),
        workspace: String(workspaceNote).slice(0, 200),
        voice: args.voice ? String(voiceNote).slice(0, 300) : "",
      };
    },
  });

  // --- theater_say：投一手 cue ---
  ctx.tools.register({
    name: "theater_say",
    description:
      "向一个角色会话投递一条 cue，等这一手演完，返回该角色输出的原文（台词/行为/内心）。演员会话不存在时按演员表自动唤醒。默认后台送达、不切换主人的窗口；要让观众跟着看戏才传 focus: true。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "角色会话 id。" },
        name: { type: "string", description: "角色名；给 name 时按演员表查 sessionId。" },
        text: { type: "string", description: "cue 全文：本拍的情境 + 该角色此刻要做的事。" },
        timeoutMs: { type: "integer", description: `等待上限，默认 ${DEFAULT_TIMEOUT_MS}。` },
        focus: {
          type: "boolean",
          description:
            "是否把主人的窗口切到目标会话（默认 false：后台送达、不切窗）。要让观众跟着看戏才传 true。",
        },
        gate: {
          type: "boolean",
          description: "出完这一手，是否在该角色的会话里弹一张确认卡等观测者放行（默认 true）。",
        },
      },
      required: ["text"],
    },
    output: textOutput({
      type: "object",
      additionalProperties: true,
      properties: {
        sessionId: { type: "string" },
        reply: { type: "string" },
        gate: { type: "string" },
      },
    }),
    async execute(args, exec) {
      const caller = exec && exec.agent && exec.agent.session && exec.agent.session.id;
      const focus = args.focus === true;
      directorSessionId = focus && caller ? String(caller) : "";
      let sessionId = args.sessionId;
      if (!sessionId && args.name) {
        const record = actors()[args.name];
        if (!record || !record.sessionId) throw new Error(`演员表里没有「${args.name}」，先用 theater_open 建会话`);
        sessionId = record.sessionId;
      }
      if (!sessionId) throw new Error("theater_say 需要 sessionId 或 name");
      const reply = await say(sessionId, args.text, args.timeoutMs, focus);
      let gate = "";
      if (args.gate !== false) {
        try {
          gate = await askGate(sessionId);
        } catch (error) {
          gate = `弹卡失败：${String(error && error.message)}`;
        }
      }
      return { sessionId, reply, gate };
    },
  });

  // --- theater_bind：给会话绑音色 ---
  ctx.tools.register({
    name: "theater_bind",
    description: "给某个已存在的会话绑定 GPT-SoVITS 音色（写 dsh-tts 的 sessionVoices，下一条消息自动生效）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "会话 id；写 current 表示当前会话。" },
        name: { type: "string", description: "角色名；给 name 时按演员表查 sessionId。" },
        voice: { type: "string", description: "音色名。" },
        lang: { type: "string", description: "语种 zh/ja/en（可省略，按音色自身语种）。" },
      },
      required: ["voice"],
    },
    output: textOutput({
      type: "object",
      additionalProperties: true,
      properties: {
        sessionId: { type: "string" },
        result: { type: "string" },
      },
    }),
    async execute(args) {
      let sessionId = args.sessionId;
      if (!sessionId && args.name) {
        const record = actors()[args.name];
        if (record && record.sessionId) sessionId = record.sessionId;
      }
      if (!sessionId) throw new Error("theater_bind 需要 sessionId 或 name");
      const result = await bindVoice(sessionId, args.voice, args.lang);
      const map = actors();
      const hit = Object.values(map).find((item) => item && item.sessionId === sessionId);
      if (hit) {
        hit.voice = args.voice;
        hit.lang = args.lang || null;
        writeJson(ACTORS_FILE, map);
      }
      return { sessionId, result: result.slice(0, 500) };
    },
  });

  // --- theater_rename：把会话名改成角色名 ---
  ctx.tools.register({
    name: "theater_rename",
    description: "把某个会话的名字改成角色名（写 session/title 事件，侧边栏立即显示）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", description: "会话 id。" },
        name: { type: "string", description: "角色名；给 name 时按演员表查 sessionId。" },
        title: { type: "string", description: "新名字；省略时用 name。" },
      },
    },
    output: textOutput({
      type: "object",
      additionalProperties: true,
      properties: {
        sessionId: { type: "string" },
        title: { type: "string" },
      },
    }),
    async execute(args) {
      let sessionId = args.sessionId;
      if (!sessionId && args.name) {
        const record = actors()[args.name];
        if (record && record.sessionId) sessionId = record.sessionId;
      }
      if (!sessionId) throw new Error("theater_rename 需要 sessionId 或演员表里已有的 name");
      const title = String(args.title || args.name || "").trim();
      if (!title) throw new Error("缺少 title");
      const agent = await resolveAgent(ctx, sessionId);
      const titles = ctx.get("sessionTitle");
      if (!titles) throw new Error("sessionTitle 服务不可用，无法改名");
      const accepted = titles.rename(agent.session, title);
      return { sessionId, title: accepted && accepted.title ? String(accepted.title) : title };
    },
  });

  // --- theater_cast：演员表 + 存活状态 ---
  ctx.tools.register({
    name: "theater_cast",
    description: "列出演员表里登记的角色会话，并标注当前是否活着（live）。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: textOutput({
      type: "object",
      additionalProperties: true,
      properties: { actors: { type: "array" } },
    }),
    async execute() {
      const agents = ctx.get("agents");
      const list = Object.values(actors()).map((item) => ({
        name: item.name,
        sessionId: item.sessionId,
        preset: item.preset || "",
        voice: item.voice || "",
        live: Boolean(agents && agents.get(item.sessionId)),
      }));
      return { actors: list };
    },
  });

  // --- GUI 跟随：/api/dsh-theater/now（客户端插件轮询，自动切到当前说话人的会话） ---
  try {
    ctx.inject(["webServer"], (web) => {
      try {
        const server = typeof web.get === "function" ? web.get("webServer") : undefined;
        if (!server || typeof server.register !== "function") return;
        web.effect(
          () =>
            server.register({
              kind: "exact",
              path: "/api/dsh-theater/now",
              handler: (req, res) =>
                guardGet(req, res, () => writeJsonResponse(res, 200, { seq: nowState.seq, sessionId: nowState.sessionId })),
            }),
          "theater: now route",
        );
      } catch (error) {
        console.warn("[theater] route registration failed:", error);
      }
    });
  } catch (error) {
    console.warn("[theater] webServer unavailable:", error);
  }
}
