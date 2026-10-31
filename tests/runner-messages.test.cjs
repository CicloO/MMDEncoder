require("./isolate.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRunner } = require("../backend/process-runner.cjs");
const { serializeError } = require("../backend/errors.cjs");
const { load } = require("./load-typescript.cjs");
const { execFileSync } = require("node:child_process");
const { createEncoder } = require("../backend/encode-job.cjs");
const { createFileDetails } = require("../backend/file-details.cjs");
const rtx = require("../backend/rtx-check.cjs");
const core = require("../backend/core.cjs");
const catalog = require("../locales/zh-CN.json");
function harness(disposed = false) {
  const children = new Set();
  let active = null;
  const run = createRunner({
    isDisposed: () => disposed,
    children,
    getActive: () => active,
    setActive: (value) => {
      active = value;
    },
  });
  return { run, children, active: () => active };
}
const node = (script) => ({ exe: process.execPath, args: ["-e", script] });
async function failure(operation) {
  let result;
  await assert.rejects(operation, (error) => {
    result = error;
    return true;
  });
  return result;
}
function coded(error, code) {
  assert.equal(error.runnerErrorData.code, code);
  const stored = JSON.parse(JSON.stringify(serializeError(error)));
  assert.equal(stored.code, code);
  assert.ok(catalog["error." + code]);
  const i18n = load("src/i18n.ts");
  i18n.localeRuntime.registerCatalog("en-XA", {
    ["error." + code]: "⟦ Runner cause ··· ⟧",
  });
  i18n.setLocale("en-XA");
  assert.equal(i18n.errorMessage(stored), "⟦ Runner cause ··· ⟧");
  return stored;
}
test("runner-owned failures gain display descriptors without replacing exit codes or process state", async () => {
  const disposed = harness(true);
  const closed = await failure(disposed.run("must-not-start", []));
  coded(closed, "RUNNER_CLOSED");
  assert.equal(closed.code, undefined);
  assert.equal(disposed.children.size, 0);
  assert.equal(disposed.active(), null);
  const h = harness();
  const nonzero = await failure(
    h.run(
      process.execPath,
      ["-e", "process.stdout.write('before exit');process.exit(7)"],
      { encoding: true },
    ),
  );
  const stored = coded(nonzero, "RUNNER_EXIT");
  assert.equal(nonzero.code, 7);
  assert.equal(nonzero.systemCode, undefined);
  assert.equal(nonzero.timedOut, false);
  assert.equal(nonzero.stdout, "before exit");
  assert.equal(nonzero.stderr, "");
  assert.ok(Object.values(stored.params).includes(7));
  assert.equal(h.children.size, 0);
  assert.equal(h.active(), null);
  const timed = await failure(
    h.run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      encoding: true,
      timeout: 250,
    }),
  );
  coded(timed, "RUNNER_TIMEOUT");
  assert.equal(timed.timedOut, true);
  assert.equal(typeof timed.stdout, "string");
  assert.equal(typeof timed.stderr, "string");
  assert.equal(h.children.size, 0);
  assert.equal(h.active(), null);
});
test("external stderr and spawn identities remain original diagnostics", async () => {
  const h = harness();
  const raw = "Error invoking remote method 'external': Error: 外部{a}\n";
  const error = await failure(
    h.run(
      process.execPath,
      [
        "-e",
        `process.stdout.write('out');process.stderr.write(${JSON.stringify(raw)});process.exit(5)`,
      ],
      { encoding: true },
    ),
  );
  assert.equal(error.code, 5);
  assert.equal(error.stdout, "out");
  assert.equal(error.stderr, raw);
  assert.equal(error.message, raw.trim());
  assert.equal(error.runnerErrorData, undefined);
  assert.equal(serializeError(error).message, raw.trim());
  const missing = await failure(
    h.run(
      path.join(os.tmpdir(), "missing-runner-" + process.pid + ".exe"),
      [],
      { encoding: true },
    ),
  );
  assert.equal(missing.systemCode, "ENOENT");
  assert.equal(missing.code, undefined);
  assert.equal(missing.runnerErrorData, undefined);
  assert.match(missing.message, /ENOENT/);
  assert.equal(h.children.size, 0);
  assert.equal(h.active(), null);
});
test("piped failures retain node identity and stderr priority alongside display data", async () => {
  for (const raw of ["", "engine stderr: 原样{a}\n"]) {
    const h = harness();
    const command = {
      ...node(
        `process.stdin.resume();setTimeout(()=>{process.stderr.write(${JSON.stringify(raw)});process.exit(17)},100)`,
      ),
      pipeFrom: node("setInterval(()=>process.stdout.write('x'),20)"),
      pipeTo: node("process.stdin.resume();"),
    };
    const error = await failure(
      h.run.piped(command, { encoding: true, timeout: 5000 }),
    );
    assert.equal(error.code, 17);
    assert.equal(error.systemCode, 17);
    assert.equal(error.processIndex, 1);
    assert.equal(error.timedOut, false);
    assert.equal(error.cancelled, false);
    if (raw) {
      assert.equal(error.message, raw.trim());
      assert.equal(error.runnerErrorData, undefined);
    } else coded(error, "RUNNER_PIPE_EXIT");
    assert.equal(h.children.size, 0);
    assert.equal(h.active(), null);
  }
});

test("pipe timeout and cancellation preserve original flags and stderr precedence", async () => {
  for (const mode of ["timeout", "cancel"]) {
    for (const raw of ["", "original pipe diagnostic {a}\n"]) {
      const h = harness();
      const command = {
        ...node("process.stdin.pipe(process.stdout)"),
        pipeFrom: node(
          `process.stderr.write(${JSON.stringify(raw)});setInterval(()=>process.stdout.write('x'),20)`,
        ),
        pipeTo: node(
          "let sent=false;process.stdin.on('data',()=>{if(!sent){sent=true;process.stdout.write('READY')}})",
        ),
      };
      const error = await failure(
        h.run.piped(command, {
          encoding: true,
          timeout: mode === "timeout" ? 350 : 5000,
          onData: (_value, stream) => {
            if (mode === "cancel" && stream === "out") h.active().kill();
          },
        }),
      );
      assert.equal(error.code, undefined);
      assert.equal(error.systemCode, undefined);
      assert.equal(error.processIndex, undefined);
      assert.equal(error.timedOut, mode === "timeout");
      assert.equal(error.cancelled, mode === "cancel");
      if (raw) {
        assert.equal(error.message, raw.trim());
        assert.equal(error.runnerErrorData, undefined);
      } else
        coded(
          error,
          mode === "timeout" ? "RUNNER_TIMEOUT" : "RUNNER_CANCELLED",
        );
      assert.equal(h.children.size, 0);
      assert.equal(h.active(), null);
    }
  }
});

test("encoding, details and RTX retain actual runner causes for locale changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-consumers-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  try {
    const cause = await failure(
      harness().run(process.execPath, ["-e", "process.exit(11)"]),
    );
    const job = {
      id: "job",
      path: path.join(dir, "source.mov"),
      status: "ready",
      settings: {
        ...core.DEFAULTS,
        encoder: "libx264",
        preset: "medium",
        outputMode: "custom",
        outputDir: dir,
      },
      meta: { width: 320, height: 180, duration: 1, fps: 30 },
    };
    const encode = createEncoder({
      engineInfo: () => ({ ffmpeg: "fixture" }),
      engines: () => core.ENGINES,
      verification: () => ({}),
      isStopped: () => false,
      jobIndex: () => 1,
      nameSource: (j) => j.path,
      appendEvidence: () => {},
      run: async () => {
        throw cause;
      },
      commit: () => assert.fail("failed output must not commit"),
      emit: () => {},
      emitProgress: () => {},
    });
    await encode(job);
    assert.equal(job.status, "failed");
    assert.equal(job.softwareRetry, true);
    assert.equal(job.errorData.code, "VIDEO_ENGINE_FAILED");
    assert.equal(job.errorData.params.error.code, "RUNNER_EXIT");
    assert.equal(cause.code, 11);
    fs.writeFileSync(job.path, "fixture");
    const read = createFileDetails({
      isToolsBusy: () => false,
      requireJob: () => job,
      requireMediaJob: () => job,
      locate: async () => {},
      ffprobe: () => "fixture",
      run: async () => {
        throw cause;
      },
      inputArgs: () => [],
    });
    const details = await read({ id: job.id });
    assert.equal(details.before.code, "DETAILS_READ_FAILED");
    assert.equal(details.before.params.error.code, "RUNNER_EXIT");
    let verification = {};
    await assert.rejects(
      rtx.testEnhancements({
        settings: core.DEFAULTS,
        check: async () => {
          throw cause;
        },
        onStart: (s) => {
          verification = s;
        },
        onPatch: (s) => Object.assign(verification, s),
        onLog: () => {},
        emit: () => {},
      }),
    );
    assert.equal(verification.errorData.code, "RUNNER_EXIT");
    assert.equal(verification.messageData.params.error.code, "RUNNER_EXIT");
    const i18n = load("src/i18n.ts");
    i18n.localeRuntime.registerCatalog("en-XA", {
      "error.RUNNER_EXIT": "⟦ Exit {exitCode} ··· ⟧",
      "error.VIDEO_ENGINE_FAILED": "⟦ Encode ··· ⟧ {detail}",
      "error.DETAILS_READ_FAILED": "⟦ Details ··· ⟧ {detail}",
      "message.RTX_FAILED": "⟦ RTX ··· ⟧ {detail}",
    });
    i18n.setLocale("en-XA");
    assert.equal(
      i18n.errorMessage(JSON.parse(JSON.stringify(job.errorData))),
      "⟦ Encode ··· ⟧ ⟦ Exit 11 ··· ⟧",
    );
    assert.equal(
      i18n.errorMessage(JSON.parse(JSON.stringify(details.before))),
      "⟦ Details ··· ⟧ ⟦ Exit 11 ··· ⟧",
    );
    assert.equal(
      i18n.summaryMessage(JSON.parse(JSON.stringify(verification.messageData))),
      "⟦ RTX ··· ⟧ ⟦ Exit 11 ··· ⟧",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detection-list failure keeps a real child exit cause in the service notice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-detection-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  try {
    const engines = path.join(dir, "engines"),
      result = path.join(dir, "state.json");
    fs.mkdirSync(engines);
    for (const name of ["ffmpeg.exe", "ffprobe.exe"])
      fs.writeFileSync(path.join(engines, name), "fixture location");
    // A fresh Node process installs the spawn adapter before loading the actual
    // service/runner. Real Node children stand in for version/capability checks;
    // the encoder-list child exits 19. No GPU or real tool install is required.
    const script = `
const cp=require('node:child_process'),original=cp.spawn;
cp.spawn=(exe,args,options)=>{
 if(exe==='reg')return original(process.execPath,['-e',"console.log(' DriverDesc REG_SZ Fixture\\n DriverVersion REG_SZ 1')"],options);
 if(String(exe).startsWith(${JSON.stringify(engines)})){
  const body=args.includes('-encoders')?'process.exit(19)':args.includes('-version')?"console.log('fixture version')":'process.exit(1)';
  return original(process.execPath,['-e',body],options);
 }return original(exe,args,options);
};
const {createService}=require(${JSON.stringify(path.resolve("backend/service.cjs"))});
(async()=>{const s=createService({dataDir:${JSON.stringify(path.join(dir, "data"))},engineDir:${JSON.stringify(engines)},toolsRoot:${JSON.stringify(path.join(dir, "tools"))}});try{await s.invoke('detect');require('node:fs').writeFileSync(${JSON.stringify(result)},JSON.stringify(s.getState()));}finally{s.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});`;
    execFileSync(process.execPath, ["-e", script], {
      windowsHide: true,
      timeout: 15000,
    });
    const state = JSON.parse(fs.readFileSync(result));
    assert.equal(state.noticeData.code, "ENGINE_DETECTION_CAUSE");
    assert.equal(state.noticeData.params.error.code, "RUNNER_EXIT");
    assert.equal(state.noticeData.params.error.params.exitCode, 19);
    assert.equal(state.notice, "编码器退出：19");
    const i18n = load("src/i18n.ts");
    i18n.localeRuntime.registerCatalog("en-XA", {
      "error.RUNNER_EXIT": "⟦ Exit {exitCode} ··· ⟧",
      "message.ENGINE_DETECTION_CAUSE": "{detail}",
    });
    i18n.setLocale("en-XA");
    assert.equal(i18n.summaryMessage(state.noticeData), "⟦ Exit 19 ··· ⟧");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
