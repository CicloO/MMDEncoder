import { MediaTools } from "../../../src/MediaTools";
import { invoke } from "../../../src/ipc";
import type { MediaJob } from "../../../src/types";
const audio = { codec: "pcm_s16le", sampleRate: 44100, channels: 2, bits: 16 };
const meta = {
  width: 1920,
  height: 1080,
  fps: 30,
  fpsText: "30000/1001",
  duration: 3,
  size: 100,
  codec: "h264",
  pixFmt: "yuv420p",
  bitDepth: 8,
  hasAlpha: false,
  audio,
};
const jobs: MediaJob[] = [
  {
    id: "ready",
    path: "C:/source/User video.mov",
    name: "User video.mov",
    size: 100,
    status: "ready",
    meta,
    audioPath: "C:/source/User song.wav",
    audioMeta: audio,
    audioOffset: 0.125,
  },
  {
    id: "failed",
    path: "C:/source/User failed.mov",
    name: "User failed.mov",
    size: 100,
    status: "failed",
    meta,
    error: "Diagnostic fallback",
    errorData: {
      code: "MEDIA_COPY_ALIGN",
      params: {},
      message: "Diagnostic fallback",
    },
    log: "Foreign diagnostic stays exact",
  },
  {
    id: "cancelled",
    path: "C:/source/User cancelled.mov",
    name: "User cancelled.mov",
    size: 100,
    status: "cancelled",
  },
  {
    id: "done",
    path: "C:/source/User done.wav",
    name: "User done.wav",
    status: "done",
    size: 100,
    elapsed: 12,
    output:
      "C:/output/User 保存后的很长文件名用于验证中部省略与完整可访问文字 (2).wav",
  },
];
export function MediaFixture() {
  return (
    <div className="app-shell">
      <div className="page">
        <MediaTools
          jobs={jobs}
          running={false}
          detecting={false}
          toolsBusy={false}
          enhancementsBusy={false}
          call={async (action, payload) => {
            if (action === "mediaSuggest") return "C:/output/User result.flac";
            if (action === "mediaLog") return "Foreign diagnostic stays exact";
            return invoke(action, payload);
          }}
        />
      </div>
    </div>
  );
}
