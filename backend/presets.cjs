"use strict";
const crypto = require("node:crypto");
const core = require("./core.cjs");
const {
  appError,
  summary,
  sourceText,
  serializeError,
} = require("./errors.cjs");
const clone = (x) => JSON.parse(JSON.stringify(x));
function settingsEdited(p) {
  const shipped = core.BUILTINS.find((b) => b.id === p.id);
  return (
    !!shipped &&
    Object.keys(shipped.settings).some(
      (k) => k !== "presetName" && p.settings[k] !== shipped.settings[k],
    )
  );
}
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
                      (k === "upscaler" && v === "lanczos") ||
                      (k === "maskFormat" && v === "lossless")
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
      throw appError("PRESET_NAME_INVALID");
    p = {
      ...p,
      settings: {
        ...core.DEFAULTS,
        audioBitrate: 320,
        resizeMode: "source",
        width: 1920,
        height: 1080,
        keepAspect: true,
        resizeAxis: "width",
        ...p.settings,
        presetName: p.name.trim(),
      },
    };
    try {
      schema(p.settings, true);
    } catch (e) {
      throw appError("PRESET_SETTINGS_INVALID", {
        detail: e.message,
        error: serializeError(e),
      });
    }
    const s = { ...p.settings, outputMode: "encoded", outputDir: "" };
    const issues = core.validateIssues(s);
    const errors = [...new Set(issues.map((issue) => issue.message))];
    if (errors.length)
      throw appError("PRESET_SETTINGS_INVALID", {
        detail: errors.join("；"),
        errors: issues,
      });
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
              // Old overrides did not record intent. Preserve every saved name,
              // including one equal to today's source default, as user content.
              nameSource: o.nameSource === "builtin" ? "builtin" : "user",
              ...(o.nameDisambiguation === true
                ? { nameDisambiguation: true }
                : {}),
            });
            r.settingsEdited = settingsEdited(r);
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
        model.noticeData = summary("PRESET_UNREADABLE", {
          name: p?.name || sourceText("preset.unnamed"),
          ...(!p?.name ? { unnamed: true } : {}),
          detail: e.message,
          error: serializeError(e),
        });
        model.notice = model.noticeData.message;
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
        b.name = `${b.name} (Built-in)`;
        b.nameDisambiguation = true;
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
                      nameSource: p.nameSource,
                      ...(p.nameDisambiguation
                        ? { nameDisambiguation: true }
                        : {}),
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
          throw appError("PRESET_DUPLICATE");
        if (payload.id) {
          const p = model.presets.find((x) => x.id === payload.id);
          if (!p) throw appError("PRESET_MISSING");
          Object.assign(valid, {
            id: p.id,
            builtin: p.builtin,
            ...(p.builtin
              ? {
                  edited: true,
                  nameKey: p.nameKey,
                  nameSource: valid.name === p.name ? p.nameSource : "user",
                  ...(valid.name === p.name && p.nameDisambiguation
                    ? { nameDisambiguation: true }
                    : {}),
                }
              : {}),
            ...(typeof p.hidden === "boolean" ? { hidden: p.hidden } : {}),
          });
          if (valid.builtin) valid.settingsEdited = settingsEdited(valid);
          model.presets = model.presets.map((x) => (x.id === p.id ? valid : x));
        } else model.presets.push(valid);
        if (!own) model.settings.presetName = valid.name;
        return model;
      }
      case "renamePreset": {
        const p = model.presets.find((p) => p.id === payload.id);
        if (!p) throw appError("PRESET_MISSING");
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
          throw appError("PRESET_DUPLICATE");
        p.name = renamed.name;
        p.settings.presetName = renamed.name;
        if (p.builtin) {
          p.edited = true;
          p.nameSource = "user";
          delete p.nameDisambiguation;
        }
        return model;
      }
      case "applyPreset": {
        const p = model.presets.find((x) => x.id === payload.id);
        if (!p) throw appError("PRESET_MISSING");
        const output = {
          outputMode: model.settings.outputMode,
          outputDir: model.settings.outputDir,
        };
        model.settings = { ...clone(p.settings), ...output };
        return model;
      }
      case "deletePreset": {
        const p = model.presets.find((x) => x.id === payload.id);
        if (!p) throw appError("PRESET_MISSING");
        if (p.builtin) deletedBuiltins.add(p.id);
        model.presets = model.presets.filter((x) => x.id !== p.id);
        return model;
      }
      case "hidePreset": {
        const p = model.presets.find((x) => x.id === payload.id);
        if (!p) throw appError("PRESET_MISSING");
        if (typeof payload.hidden !== "boolean")
          throw appError("PRESET_PARAMETERS_INVALID");
        p.hidden = payload.hidden;
        return model;
      }
      case "reorderPresets":
        try {
          model.presets = reorder(model.presets, payload.ids);
        } catch {
          throw appError("PRESET_ORDER_INVALID");
        }
        return model;
      case "resolvePresetConflict": {
        // keep: save the user's old version as a personal preset next to the
        // built-in; otherwise drop it (the new built-in stays either way).
        const c = model.presetConflicts.find((x) => x.id === payload.id);
        if (!c) throw appError("PRESET_CONFLICT_MISSING");
        if (payload.keep) {
          let name = `${c.name} (Modified)`;
          for (
            let n = 2;
            model.presets.some((p) => sameName(p.name, name));
            n++
          )
            name = `${c.name} (Modified ${n})`;
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
            throw appError("PRESET_RESTORE_DUPLICATE", { name: p.name });
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
          throw appError("PRESET_IMPORT_INVALID");
        const incoming = payload.presets.map(presetValid);
        const names = new Set(
          model.presets.map((p) => p.name.toLocaleLowerCase()),
        );
        for (const p of incoming) {
          const key = p.name.toLocaleLowerCase();
          if (names.has(key))
            throw appError("PRESET_IMPORT_DUPLICATE", { name: p.name });
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
