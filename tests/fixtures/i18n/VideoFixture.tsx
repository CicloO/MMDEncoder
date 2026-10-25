import { useEffect, useState } from "react";
import { EncodeQueue } from "../../../src/EncodeQueue";
import { EncodeFooter } from "../../../src/EncodeFooter";
import { VideoSettings } from "../../../src/VideoSettings";
import { VideoSettingsPanel } from "../../../src/VideoSettingsPanel";
import { VideoFeedback } from "../../../src/VideoFeedback";
import { useDragSort } from "../../../src/components";
import { errorMessage, summaryMessage } from "../../../src/i18n";
import type { Settings, State, Job } from "../../../src/types";
import type { MessageDescriptor } from "../../../src/i18n";
import source from "../../../locales/zh-CN.json";

let snapshot = () => ({});
export const videoSnapshot = () => snapshot();
let mounts = 0;
export function VideoFixture({ state }: { state: State }) {
  const [settings, setSettings] = useState<Settings>({
    ...state.settings,
    encoder: "libx264",
    preset: "medium",
    nameTemplate: "{name}_User名",
    fps: "30000/1001",
  });
  const [tab, setTab] = useState("encoding");
  const [customFPS, setCustomFPS] = useState(false);
  const [selected, setSelected] = useState("encoding-fixture");
  const [notice, setNotice] = useState<MessageDescriptor | string>("");
  const jobs: Job[] = [
    {
      id: "encoding-fixture",
      name: "User 视频.mov",
      path: "C:/source/User 视频.mov",
      status: "encoding",
      progress: 20,
      elapsed: 12,
      stage: {
        stage: "video_encoding_with_mask",
        params: {},
        message: source["stage.video_encoding_with_mask"],
      },
      meta: {
        width: 1920,
        height: 1080,
        fps: 30,
        fpsText: "30/1",
        duration: 60,
        size: 100,
        codec: "h264",
        pixFmt: "yuv420p",
        bitDepth: 8,
        hasAlpha: true,
      },
    },
    {
      id: "partial-fixture",
      name: "User partial.mov",
      path: "C:/source/User partial.mov",
      status: "partial",
      progress: 80,
      elapsed: 5,
      error: "legacy fallback",
      errorData: {
        code: "VALIDATION_FAILED",
        params: {},
        message: "legacy fallback",
        issues: [
          {
            code: "AUDIO_BITRATE_INVALID",
            params: {},
            message: "source fallback",
          },
          {
            code: "FUTURE_VIDEO_ERROR",
            params: {},
            message: "Foreign diagnostic stays exact",
          },
        ],
      },
      output: "C:/output/User partial (2).mp4",
    },
    {
      id: "complete-fixture",
      name: "User completed.mov",
      path: "C:/source/User completed.mov",
      status: "done",
      progress: 100,
      elapsed: 2,
      noteData: {
        code: "MASK_GPU_RUNTIME_FALLBACK",
        params: {},
        message: source["message.MASK_GPU_RUNTIME_FALLBACK"],
      },
      output:
        "C:/output/用户保留很长的成品名称用于检查省略位置保留扩展名和完整路径提示 (2).mp4",
      maskOutput:
        "C:/output/用户保留很长的成品名称用于检查省略位置保留扩展名和完整路径提示 (2)_alpha.mp4",
    },
  ];
  const job = jobs.find((j) => j.id === selected)!;
  const sort = useDragSort(
    jobs.map((j) => j.id),
    () => {},
  );
  const engines = state.engines.some((e) => e.backend === "nvencc")
    ? state.engines
    : [
        ...state.engines,
        {
          id: "nvencc:hevc",
          label: "HEVC · NVEncC",
          backend: "nvencc",
          codec: "hevc",
          depths: [8, 10],
        },
      ];
  const engine = engines.find((e) => e.id === settings.encoder);
  const verification = {
    ...state.enhancements,
    message: source["message.RTX_SETTINGS_CHANGED"],
    messageData: {
      code: "RTX_SETTINGS_CHANGED",
      params: {},
      message: source["message.RTX_SETTINGS_CHANGED"],
    },
  };
  useEffect(() => {
    mounts++;
  }, []);
  snapshot = () => ({
    settings,
    selected,
    tab,
    customFPS,
    mounts,
    stage: jobs[0].stage,
    progress: jobs[0].progress,
  });
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  const preview = {
    summary: "",
    output: "C:/output/User result.mp4",
    errors: [],
    dimensions: { width: 1920, height: 1080 },
    command: "ffmpeg -i 'User 视频.mov'",
  };
  return (
    <div className="app-shell">
      <div className="page">
        <div className="page-scroll">
          <main className="workspace">
            <EncodeQueue
              engines={engines}
              running={false}
              toolsBusy={false}
              jobs={jobs}
              job={job}
              s={settings}
              page={0}
              setPage={() => {}}
              pageCount={1}
              setSelected={setSelected}
              drag={false}
              busy={false}
              doneCount={1}
              sortJob={sort}
              add={() => {}}
              call={async () => null}
              action={(_name, _payload, message) =>
                message && setNotice(message)
              }
              pickAudio={() => {}}
              persist={async () => {}}
              openLog={() => {}}
              setDetails={() => {}}
              setModal={() => {}}
              setError={() => {}}
              setTab={setTab}
              setFallback={() => {}}
            />
            <VideoSettingsPanel
              own={true}
              ownDisabled={false}
              jobName={job.name}
              onOwn={() => {}}
              presets={state.presets}
              presetId={state.presets[0].id}
              modified={true}
              presetHidden={() => false}
              onSelectPreset={() => {}}
              hasActivePreset={true}
              activePresetLabel="User preset 预设"
              busy={false}
              onOverwrite={() => {}}
              onSaveAs={() => {}}
              tab={tab}
              setTab={setTab}
            >
              <VideoSettings
                s={settings}
                tab={tab}
                engine={engine}
                backend={engine?.backend || "cpu"}
                engines={engines}
                detecting={false}
                verification={verification}
                placebo={true}
                canTest={true}
                job={job}
                preview={preview}
                customFPS={customFPS}
                setCustomFPS={setCustomFPS}
                set={set}
                changed={setSettings}
                call={async () => null}
                copy={() => {}}
                pickDirectory={() => {}}
              />
            </VideoSettingsPanel>
          </main>
        </div>
        <EncodeFooter
          s={settings}
          job={jobs[0]}
          preview={preview}
          engine={engine}
          backend={engine?.backend || "cpu"}
          running={false}
          readyCount={1}
          doneCount={2}
          busy={false}
          errorCount={1}
          onCancel={() => {}}
          onStart={() => {}}
        />
      </div>
      <output
        className={`toast ${notice ? "visible" : ""}`}
        role="status"
        aria-label="video notification"
      >
        {summaryMessage(notice)}
      </output>
      {selected === "partial-fixture" && (
        <VideoFeedback
          message={errorMessage(job.errorData)}
          suggestions={[
            {
              id: "compatible",
              code: "COMPAT_ENCODER_FIX",
              params: {},
              message: "legacy fix",
              label: "legacy fix",
              patch: { preset: "medium" },
            },
          ]}
          running={false}
          onFix={() => {}}
          onDismiss={() => setSelected("encoding-fixture")}
        />
      )}
    </div>
  );
}
