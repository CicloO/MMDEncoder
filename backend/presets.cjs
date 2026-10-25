"use strict";
const crypto = require("node:crypto");
const core = require("./core.cjs");
const clone = (x) => JSON.parse(JSON.stringify(x));
function createPresetOperations({ schema, reorder }) {
  // Identifies the shipped definition of a built-in preset, so an edit made to
  // one version of it is dropped once an update ships a different definition.
  function builtinFingerprint(p) {
    const shipped = core.BUILTINS.find((b) => b.id === p.id);
    return shipped
      ? crypto
          .createHash("sha256")
          // Settings added later with their off value (hiRes, editFriendly) are left
          // out, so adding a setting does not count as changing every preset.
          .update(
            JSON.stringify([
              shipped.name,
              Object.fromEntries(
                Object.entries(shipped.settings).filter(
                  ([k, v]) =>
                    !(
                      (["hiRes", "editFriendly"].includes(k) && v === false) ||
                      (k === "audioFade" && v === 0) ||
                      (k === "artcnnModel" && v === "C4F16") ||
                      (k === "upscaler" && v === "lanczos")
                    ),
                ),
              ),
            ]),
          )
          .digest("hex")
          .slice(0, 16)
      : "";
  }
  function sameName(a, b) {
    return a.toLocaleLowerCase() === b.toLocaleLowerCase();
  }

  function presetValid(p) {
    if (
      !p ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 80
    )
      throw Error("预设名称须为 1–80 字符");
    p = {
      ...p,
      settings: {
        ...core.DEFAULTS,
        audioBitrate: 0,
        resizeMode: "source",
        width: 1920,
        height: 1080,
        keepAspect: true,
        resizeAxis: "width",
        ...p.settings,
        presetName: p.name.trim(),
      },
    };
    schema(p.settings, true);
    const s = { ...p.settings, outputMode: "encoded", outputDir: "" };
    const errors = core.validate(s);
    if (errors.length) throw Error("预设参数无效：" + errors.join("；"));
    return {
      id: crypto.randomUUID(),
      name: p.name.trim(),
      builtin: false,
      settings: clone(p.settings),
    };
  }

  function restore(saved, model, { deletedBuiltins, unreadable }) {
    for (const id of saved.deletedBuiltins || [])
      if (typeof id === "string") deletedBuiltins.add(id);
    // Personal presets always survive an update. A built-in the new version
    // changed (its fingerprint no longer matches) takes the new definition, and
    // the user's edit of it becomes a conflict they resolve in the app: drop it
    // or keep it as a personal preset. A built-in the new version dropped
    // simply disappears.
    const overrides =
      saved.builtins && typeof saved.builtins === "object"
        ? saved.builtins
        : {};
    const conflict = (id, o, builtinName) => {
      try {
        const v = presetValid({
          name: o.name || builtinName,
          settings: o.settings,
        });
        if (!model.presetConflicts.some((c) => c.id === id))
          model.presetConflicts.push({
            id,
            name: v.name,
            settings: v.settings,
            builtinName,
          });
      } catch {}
    };
    model.presets = model.presets
      .filter((p) => !deletedBuiltins.has(p.id))
      .map((p) => {
        const o = overrides[p.id];
        if (!o || typeof o !== "object") return p;
        const r = { ...p };
        if (o.settings && o.base !== builtinFingerprint(p))
          conflict(p.id, o, p.name);
        if (o.settings && o.base === builtinFingerprint(p))
          try {
            const v = presetValid({
              name: o.name || p.name,
              settings: o.settings,
            });
            Object.assign(r, {
              name: v.name,
              settings: v.settings,
              edited: true,
            });
          } catch {
            unreadable.builtins[p.id] = o;
          }
        if (typeof o.hidden === "boolean") r.hidden = o.hidden;
        return r;
      });
    for (const c of Array.isArray(saved.builtinConflicts)
      ? saved.builtinConflicts
      : []) {
      const b = model.presets.find((p) => p.builtin && p.id === c?.id);
      if (b && c.settings) conflict(b.id, c, b.name);
    }
    for (const p of saved.presets || []) {
      let valid;
      try {
        valid = presetValid(p);
      } catch (e) {
        unreadable.presets.push(p);
        model.notice = `个人预设“${p?.name || "未命名"}”暂时无法读取，已原样保留：${e.message}`;
        continue;
      }
      valid.id =
        typeof p.id === "string" && !p.id.startsWith("builtin-")
          ? p.id
          : valid.id;
      if (typeof p.hidden === "boolean") valid.hidden = p.hidden;
      model.presets.push(valid);
    }
    // A built-in that now shares a personal preset's name is the one renamed.
    for (const b of model.presets.filter((p) => p.builtin && !p.edited))
      if (
        model.presets.some(
          (p) => !p.builtin && p.id !== b.id && sameName(p.name, b.name),
        )
      ) {
        b.name += "（内置）";
        b.settings = { ...b.settings, presetName: b.name };
      }
    if (Array.isArray(saved.presetOrder)) {
      const rank = new Map(saved.presetOrder.map((id, i) => [id, i]));
      model.presets = model.presets
        .map((p, i) => [rank.get(p.id) ?? saved.presetOrder.length + i, p])
        .sort((a, b) => a[0] - b[0])
        .map(([, p]) => p);
    }
    return model;
  }
  function serialize(model, { deletedBuiltins, unreadable }) {
    return {
      presets: model.presets
        .filter((p) => !p.builtin)
        .map(({ id, name, settings, hidden }) => ({
          id,
          name,
          settings,
          ...(typeof hidden === "boolean" ? { hidden } : {}),
        }))
        .concat(unreadable.presets),
      // Built-in presets are rebuilt from code; only the user's changes are saved.
      builtins: Object.assign(
        {},
        unreadable.builtins,
        Object.fromEntries(
          model.presets
            .filter(
              (p) => p.builtin && (p.edited || typeof p.hidden === "boolean"),
            )
            .map((p) => [
              p.id,
              {
                ...(p.edited
                  ? {
                      name: p.name,
                      settings: p.settings,
                      base: builtinFingerprint(p),
                    }
                  : {}),
                ...(typeof p.hidden === "boolean" ? { hidden: p.hidden } : {}),
              },
            ]),
        ),
      ),
      deletedBuiltins: [...deletedBuiltins],
      // Unanswered update conflicts survive a restart.
      ...(model.presetConflicts.length
        ? {
            builtinConflicts: model.presetConflicts.map(
              ({ id, name, settings }) => ({ id, name, settings }),
            ),
          }
        : {}),
      presetOrder: model.presets.map((p) => p.id),
    };
  }
  function execute(action, payload, model, { deletedBuiltins }) {
    switch (action) {
      case "savePreset": {
        // payload.settings: a video's own settings ("单独设置"), saved
        // without changing the page's.
        const own = payload.settings
          ? { ...model.settings, ...schema(payload.settings) }
          : null;
        const valid = presetValid({
          name: payload.name,
          settings: own || model.settings,
        });
        if (
          model.presets.some(
            (p) =>
              p.id !== payload.id &&
              p.name.toLocaleLowerCase() === valid.name.toLocaleLowerCase(),
          )
        )
          throw Error("已存在同名预设，请使用其他名称");
        if (payload.id) {
          const p = model.presets.find((x) => x.id === payload.id);
          if (!p) throw Error("未找到预设");
          Object.assign(valid, {
            id: p.id,
            builtin: p.builtin,
            ...(p.builtin ? { edited: true } : {}),
            ...(typeof p.hidden === "boolean" ? { hidden: p.hidden } : {}),
          });
          model.presets = model.presets.map((x) => (x.id === p.id ? valid : x));
        } else model.presets.push(valid);
        if (!own) model.settings.presetName = valid.name;
        return model;
      }
      case "renamePreset": {
        const p = model.presets.find((p) => p.id === payload.id);
        if (!p) throw Error("未找到预设");
        const renamed = presetValid({
          name: payload.name,
          settings: p.settings,
        });
        if (
          model.presets.some(
            (x) =>
              x.id !== p.id &&
              x.name.toLocaleLowerCase() === renamed.name.toLocaleLowerCase(),
          )
        )
          throw Error("已存在同名预设，请使用其他名称");
        p.name = renamed.name;
        p.settings.presetName = renamed.name;
        if (p.builtin) p.edited = true;
        return model;
      }
      case "applyPreset": {
        const p = model.presets.find((x) => x.id === payload.id);
        if (!p) throw Error("未找到预设");
        const output = {
          outputMode: model.settings.outputMode,
          outputDir: model.settings.outputDir,
        };
        model.settings = { ...clone(p.settings), ...output };
        return model;
      }
      case "deletePreset": {
        const p = model.presets.find((x) => x.id === payload.id);
        if (!p) throw Error("未找到预设");
        if (p.builtin) deletedBuiltins.add(p.id);
        model.presets = model.presets.filter((x) => x.id !== p.id);
        return model;
      }
      case "hidePreset": {
        const p = model.presets.find((x) => x.id === payload.id);
        if (!p) throw Error("未找到预设");
        if (typeof payload.hidden !== "boolean") throw Error("参数无效");
        p.hidden = payload.hidden;
        return model;
      }
      case "reorderPresets":
        model.presets = reorder(model.presets, payload.ids);
        return model;
      case "resolvePresetConflict": {
        // keep: save the user's old version as a personal preset next to the
        // built-in; otherwise drop it (the new built-in stays either way).
        const c = model.presetConflicts.find((x) => x.id === payload.id);
        if (!c) throw Error("未找到待处理的预设");
        if (payload.keep) {
          let name = c.name + "（我的修改）";
          for (
            let n = 2;
            model.presets.some((p) => sameName(p.name, name));
            n++
          )
            name = `${c.name}（我的修改 ${n}）`;
          const copy = presetValid({ name, settings: c.settings });
          const at = model.presets.findIndex((p) => p.id === c.id);
          model.presets.splice(at < 0 ? model.presets.length : at + 1, 0, copy);
        }
        model.presetConflicts = model.presetConflicts.filter((x) => x !== c);
        return model;
      }
      case "restoreBuiltinPresets": {
        // Bring back deleted built-ins and undo edits / hide choices on them.
        const defaults = clone(core.BUILTINS);
        for (const p of defaults)
          if (
            !model.presets.some((x) => x.id === p.id) &&
            model.presets.some((x) => sameName(x.name, p.name))
          )
            throw Error("已有同名个人预设：" + p.name + "，请先改名");
        deletedBuiltins.clear();
        const byId = new Map(defaults.map((p) => [p.id, p]));
        model.presets = model.presets.map((p) =>
          p.builtin ? byId.get(p.id) || p : p,
        );
        for (const p of defaults)
          if (!model.presets.some((x) => x.id === p.id)) model.presets.push(p);
        return model;
      }
      case "importPresets": {
        if (!Array.isArray(payload.presets) || payload.presets.length > 200)
          throw Error("预设文件格式无效或超过 200 项");
        const incoming = payload.presets.map(presetValid);
        const names = new Set(
          model.presets.map((p) => p.name.toLocaleLowerCase()),
        );
        for (const p of incoming) {
          const key = p.name.toLocaleLowerCase();
          if (names.has(key)) throw Error("已存在同名预设：" + p.name);
          names.add(key);
        }
        model.presets.push(...incoming);
        return model;
      }

      default:
        throw Error("Unsupported preset action: " + action);
    }
  }
  return { restore, serialize, execute };
}
module.exports = { createPresetOperations };
