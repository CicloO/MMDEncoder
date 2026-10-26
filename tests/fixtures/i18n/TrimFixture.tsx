import { useEffect, useState } from "react";
import { TrimTools } from "../../../src/TrimTools";
import type { State } from "../../../src/types";

const calls: Array<{ action: string; payload: any }> = [];
let mounts = 0;
let complete = (_output: string, _elapsed: number) => {};
const initial: State["trim"] = {
  clips: [
    {
      id: "ready",
      path: "C:/source/User 原片.mp4",
      name: "User 原片.mp4",
      status: "ready",
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: { num: 30000, den: 1001 },
      frames: 120,
      cuts: [0, 30, 60, 90],
      from: 30,
      to: 90,
      requested: { from: 31, to: 91 },
      mmdStart: 400,
      mmdStartFrom: "tag",
      smartBlocker: {
        code: "TRIM_SMART_SETTINGS_MISSING",
        params: {},
        message: "Source reason",
      },
      refused: [
        {
          code: "TRIM_OPEN_GOP",
          params: {},
          message: "Source keyframe reason",
        },
      ],
    },
    {
      id: "reading",
      path: "C:/User waiting.mov",
      name: "User waiting.mov",
      status: "indexing",
    },
    {
      id: "invalid",
      path: "C:/User invalid.mov",
      name: "User invalid.mov",
      status: "invalid",
      error: "Foreign diagnostic stays exact",
    },
  ],
  running: false,
  smart: true,
  progress: 0,
  stage: "",
  output: "",
  error: "Source error",
  errorData: {
    code: "TRIM_AUDIO_CODEC_INVALID",
    params: {},
    message: "Source error",
  },
};

export function trimSnapshot() {
  return { mounts, calls: [...calls] };
}
export const completeTrim = (output: string, elapsed: number) =>
  complete(output, elapsed);

export function TrimFixture() {
  const [trim, setTrim] = useState(initial);
  complete = (output, elapsed) =>
    setTrim((current) => ({
      ...current,
      running: false,
      output,
      elapsed,
      stage: { stage: "trim_completed", params: {} },
      error: "",
      errorData: null,
    }));
  useEffect(() => {
    mounts++;
  }, []);
  return (
    <div className="app-shell">
      <div className="page">
        <TrimTools
          trim={trim}
          call={async (action, payload: any) => {
            calls.push({ action, payload });
            if (action === "trimFrame")
              return (
                "data:image/svg+xml," +
                encodeURIComponent(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#202630"/></svg>',
                )
              );
            if (action === "trimSmart")
              setTrim((current) => ({ ...current, smart: payload.smart }));
            if (action === "trimSet")
              setTrim((current) => ({
                ...current,
                clips: current.clips.map((clip) =>
                  clip.id === payload.id
                    ? {
                        ...clip,
                        from: payload.from,
                        to: payload.to === "end" ? clip.frames : payload.to,
                      }
                    : clip,
                ),
              }));
            return null;
          }}
        />
      </div>
    </div>
  );
}
