import type {
  ErrorData,
  MessageDescriptor,
  StageDescriptor,
} from "../locales/messages.mjs";
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
  maskFormat: "lossless" | "gpu-lossy" | "x264-lossy";
  // Hi-Res audio (FLAC / PCM): 24-bit, twice the rate below 48 kHz.
  hiRes: boolean;
  // A keyframe every second (automatic GOP only), for lossless cutting.
  editFriendly: boolean;
  alphaMode: string;
  // alphaMode "color": #RRGGBB under the picture.
  alphaBackground: string;
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
  upscaler: "lanczos" | "artcnn";
  artcnnModel: "C4F16" | "C4F32";
  audioFade: number;
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
  videoDuration?: number;
  size: number;
  // PNG sequence: size still being added up.
  sizing?: boolean;
  codec: string;
  pixFmt: string;
  bitDepth: number;
  hasAlpha: boolean;
  vfr?: boolean;
  videoBitRate?: number;
  // A PNG image sequence read as video.
  sequence?: { count: number; start: number };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
    channelLayout: string;
    profile?: string;
    bitRate?: number;
    // Effective bits per sample (0 = unknown) and floating-point samples.
    bits?: number;
    float?: boolean;
  };
};
export type Job = {
  id: string;
  path: string;
  name: string;
  nameData?: MessageDescriptor;
  status: string;
  progress: number;
  stage?: string | StageDescriptor;
  elapsed?: number;
  meta?: Meta;
  error?: string;
  errorData?: ErrorData;
  softwareRetry?: boolean;
  noteData?: MessageDescriptor;
  log?: string;
  output?: string;
  maskOutput?: string;
  settings?: Settings;
  // "单独设置": this video's own settings (else the page's).
  ownSettings?: Settings;
  // Replacement audio (as the media page's merge) and its parameters.
  audioPath?: string;
  audioMeta?: Meta["audio"];
  audioDuration?: number;
  // 音频对齐 of the replacement with the video's own sound (seconds).
  audioOffset?: number;
  audioShiftFrames?: number;
  // PNG sequence source: FFmpeg pattern and the frame rate the user gave it.
  sequence?: {
    pattern: string;
    start: number;
    count: number;
    fps: number;
    fpsText?: string;
  };
};
// Video metadata, or an audio-only summary for audio files on the media page.
export type MediaMeta = Partial<Meta> & {
  codec: string;
  duration: number;
  size: number;
  audio?: Meta["audio"];
  audioOnly?: boolean;
  bitRate?: number;
};
export type TrimClip = {
  id: string;
  path: string;
  name: string;
  status: "indexing" | "ready" | "invalid";
  error?: string;
  errorData?: ErrorData;
  codec?: string;
  width?: number;
  height?: number;
  fps?: { num: number; den: number };
  // Nonzero first-video PTS maps native playback to the zero-based trim clock.
  videoStartTime?: number;
  frames?: number;
  // Frames a cut may start at, or "all" when every frame can.
  cuts?: number[] | "all";
  refused?: (ErrorData | string)[];
  // MMD frame of the video's first frame and where that came from.
  mmdStart?: number | null;
  mmdStartFrom?: "tag" | "name" | "manual" | "";
  // Encode settings recorded by MMDEncoder (needed for smart cut).
  encoding?: Record<string, unknown> | null;
  // Structured reason, null when smart cut can be used.
  smartBlocker?: ErrorData | string | null;
  from?: number;
  to?: number;
  requested?: { from: number; to: number };
  empty?: boolean;
};
export type MediaJob = {
  meta?: MediaMeta;
  metaError?: string;
  metaErrorData?: ErrorData;
  id: string;
  path: string;
  name: string;
  size: number;
  status: string;
  audioPath?: string;
  // 音频对齐 of the added audio with the video's own sound (merge).
  audioOffset?: number;
  audioShiftFrames?: number;
  // 音频对齐: line the extracted audio up with a reference (offset seconds,
  // > 0 cut, < 0 padded; length: end with the reference).
  align?: {
    reference: string;
    offset: number;
    length?: number;
    shiftFrames?: number;
    fpsText?: string;
  };
  // The replacement audio's parameters, read when it is chosen.
  audioMeta?: Meta["audio"];
  output?: string;
  error?: string;
  errorData?: ErrorData;
  log?: string;
  elapsed?: number;
};
export type Preset = {
  id: string;
  name: string;
  builtin: boolean;
  // undefined = shown; true / false = set with the hide / show button
  hidden?: boolean;
  edited?: boolean;
  nameKey?: string;
  nameSource?: "builtin" | "user";
  nameDisambiguation?: boolean;
  settingsEdited?: boolean;
  settings: Settings;
};
export type Engine = {
  alpha?: boolean;
  id: string;
  label: string;
  backend: string;
  codec: string;
  depths: number[];
  labelKey?: string;
  labelParams?: { codec: string; backend: string };
};
export type State = {
  preferences: { locale: string | null; theme: "system" | "light" | "dark" };
  locale: string;
  systemLocale: string;
  jobs: Job[];
  settings: Settings;
  presets: Preset[];
  // Built-ins the user had edited that an update changed (see service.cjs).
  presetConflicts?: { id: string; name: string; builtinName: string }[];
  engines: Engine[];
  detecting: boolean;
  located?: boolean;
  running: boolean;
  enhancements: {
    busy: boolean;
    verified: boolean;
    message: string;
    messageData?: MessageDescriptor;
    errorData?: ErrorData;
    signature: string;
  };
  mediaJobs: MediaJob[];
  // Lossless trim page (backend/trim.cjs through the service).
  trim: {
    clips: TrimClip[];
    running: boolean;
    smart: boolean;
    progress: number;
    stage: StageDescriptor | string;
    output: string;
    error: string;
    errorData?: ErrorData | null;
    elapsed?: number;
  };
  mmd: {
    presetId: string;
    followMmd: boolean;
    audioFade: number;
    audioShiftFrames: number;
    audioAutoShift: boolean;
    maskMode: "off" | "with" | "only";
    rangeSuffix?: boolean;
    error: string;
    errorData?: ErrorData | null;
    interrupted: {
      id: string;
      output: string;
      temp: string;
      at: string;
      presetName: string;
      size: number;
    }[];
    plugin: {
      available: boolean;
      broken?: boolean;
      installed: boolean;
      upToDate: boolean;
      path: string;
    };
    test:
      | (Partial<ErrorData> & { ok: boolean; at: string; message: string })
      | null;
    lastExport: {
      ok: boolean;
      at: string;
      output?: string;
      mask?: string;
      audio?: string;
      error?: string;
      errorData?: ErrorData;
      startFrame?: number;
      frames?: number;
      // Seconds; written by plugins from 1.4.2 on.
      timing?: {
        setup: number;
        render: number;
        waited: number;
        longestWait: number;
        encoderTail: number;
        finish?: number;
      };
    } | null;
  };
  engineInfo: {
    ffmpeg: string;
    ffprobe: string;
    nvencc: string;
    soxr?: boolean;
    // FFmpeg can run libplacebo on Vulkan (ArtCNN upscaling).
    libplacebo?: boolean;
  };
  notice?: string;
  noticeData?: MessageDescriptor;
  tools?: {
    busy: boolean;
    phase: string;
    message: string;
    messageData?: MessageDescriptor | null;
    errorData?: ErrorData | null;
    received: number;
    total: number;
    root: string;
    installed: Record<string, { version: string; verifiedHash: boolean }>;
    available: { id: string; version: string }[];
  };
};
export type Preview = {
  maskEncoding?: {
    format: string;
    encoder: string;
    gpu: boolean;
    quality: number;
    note?: MessageDescriptor;
  };
  dimensions?: { width: number; height: number } | null;
  summary: string;
  summaryData?: MessageDescriptor;
  output: string;
  maskOutput?: string;
  command: string;
  errors: string[];
  issues?: ErrorData[];
};
declare global {
  const __APP_VERSION__: string;
  interface Window {
    encoder: {
      initialTheme?: "light" | "dark";
      invokeResult: (action: string, payload?: unknown) => Promise<any>;
      invoke: (action: string, payload?: unknown) => Promise<any>;
      onCloseRequest: (fn: () => void) => () => void;
      onUpdate: (fn: (state: State) => void) => () => void;
      getPaths: (files: File[]) => string[];
    };
  }
}
