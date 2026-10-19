/**
 * dsh-theater — Client 半
 *
 * GUI 跟随：轮询 Host 的 /api/dsh-theater/now，拿到「当前说话人」的会话 id，
 * 自动把主视图切过去。投 cue 时切到角色会话，导演这一回合结束（旁白出完）切回场景会话。
 * 只在 seq 变化时切，用户手动翻页不会被一直拽回来。
 */
window.__ModuleLoader__.load({
  id: "dsh-theater",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const NOW_URL = "api/dsh-theater/now";
    const POLL_MS = 600;
    let lastSeq = 0;
    let disposed = false;

    async function tick(uiWorkspace) {
      try {
        const res = await fetch(NOW_URL, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!data || typeof data.sessionId !== "string" || data.sessionId === "") return;
        if (typeof data.seq !== "number" || data.seq === lastSeq) return;
        lastSeq = data.seq;
        if (disposed) return;
        const current = uiWorkspace.mainReference && uiWorkspace.mainReference.sessionId;
        if (current === data.sessionId) return;
        if (typeof uiWorkspace.openSession === "function") uiWorkspace.openSession(data.sessionId);
      } catch {
        /* 轮询失败静默，下一跳再试 */
      }
    }

    function applyPlugin(ctx) {
      try {
        const uiWorkspace = ctx && ctx.uiWorkspace;
        if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") {
          console.warn("[theater] uiWorkspace.openSession 不可用，GUI 跟随未启用");
          return;
        }
        disposed = false;
        const timer = setInterval(() => tick(uiWorkspace), POLL_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
        ctx.on?.("dispose", () => {
          disposed = true;
          clearInterval(timer);
        });
      } catch (error) {
        console.warn("[theater] client auto-focus failed:", error);
      }
    }

    exports.apply = applyPlugin;
    exports.inject = ["uiWorkspace"];
    return module.exports;
  },
});
