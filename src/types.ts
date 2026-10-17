export type Settings = {
  container: string;
  encoder: string;
  quality: number;
  preset: string;
  presetName: string;
  bitDepth: number;
  chroma: string;
  rateControl: string;
  bitrate: number;
  fps: string;
  resizeMode: string;
  width: number;
  height: number;
  keepAspect: boolean;
  resizeAxis: string;
  audio: string;
  audioBitrate: number;
  alphaMask: boolean;
  alphaMode: string;
  outputMode: string;
  outputDir: string;
  nameTemplate: string;
  colorSpace: string;
  colorRange: string;
  gop: number;
  bframes: number;
  lookahead: number;
  lookaheadLevel: number;
  vsr: boolean;
  vsrScale: number;
  vsrQuality: number;
  vsrStrength: number;
  vfg: boolean;
  vfgMultiplier: number;
  vfgMode: string;
  vfgModelDir: string;
};
export type Meta = {
  width: number;
  height: number;
  fps: number | string;
  fpsText: string;
  duration: number;
  size: number;
  codec: string;
  pixFmt: string;
  bitDepth: number;
  hasAlpha: boolean;
  vfr?: boolean;
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
    channelLayout: string;
  };
};
export type Job = {
  id: string;
  path: string;
  name: string;
  status: string;
  progress: number;
  stage?: string;
  elapsed?: number;
  meta?: Meta;
  error?: string;
  log?: string;
  output?: string;
  maskOutput?: string;
  settings?: Settings;
};
export type MediaJob = {
  id: string;
  path: string;
  name: string;
  size: number;
  status: string;
  audioPath?: string;
  output?: string;
  error?: string;
  log?: string;
  elapsed?: number;
};
export type Preset = {
  id: string;
  name: string;
  builtin: boolean;
  settings: Settings;
};
export type Engine = {
  alpha?: boolean;
  id: string;
  label: string;
  backend: string;
  codec: string;
  depths: number[];
};
export type State = {
  jobs: Job[];
  settings: Settings;
  presets: Preset[];
  engines: Engine[];
  detecting: boolean;
  located?: boolean;
  running: boolean;
  enhancements: {
    busy: boolean;
    verified: boolean;
    message: string;
    signature: string;
  };
  mediaJobs: MediaJob[];
  engineInfo: { ffmpeg: string; ffprobe: string; nvencc: string };
  notice?: string;
  tools?: {
    busy: boolean;
    phase: string;
    message: string;
    received: number;
    total: number;
    root: string;
    installed: Record<string, { version: string; verifiedHash: boolean }>;
    available: { id: string; version: string }[];
  };
};
export type Preview = {
  dimensions?: { width: number; height: number } | null;
  summary: string;
  output: string;
  maskOutput?: string;
  command: string;
  errors: string[];
};
declare global {
  const __APP_VERSION__: string;
  interface Window {
    encoder: {
      invoke: (action: string, payload?: unknown) => Promise<any>;
      onCloseRequest: (fn: () => void) => () => void;
      onUpdate: (fn: (state: State) => void) => () => void;
      getPaths: (files: File[]) => string[];
    };
  }
}
