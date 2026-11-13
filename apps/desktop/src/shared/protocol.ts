import type { AnimationDetail, AnimationSummary, ExportFormat, StudioStatus } from "./api.js";

/** Where main hands the host what it needs; the first message the host reads. */
export interface HostInit {
  type: "init";
  dataDir: string;
  media: MediaPaths;
}

/** Overrides for the server's media tools; empty in development (PATH FFmpeg, default Chromium). */
export interface MediaPaths {
  ffmpeg?: string;
  ffprobe?: string;
  browsers?: string;
}

/** A file the host made, or why it could not. */
export type FileResult = { path: string } | { error: string };

export type ExportStartResult = { jobId: string } | { error: string };

export interface ExportResultReply {
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  file?: string;
  error?: string;
}

/** Request params and results of the host, by method. */
export interface HostMethods {
  status: { params: undefined; result: StudioStatus };
  listAnimations: { params: undefined; result: AnimationSummary[] };
  animation: { params: { id: string }; result: AnimationDetail | null };
  thumbnail: { params: { id: string }; result: FileResult };
  preview: { params: { id: string }; result: FileResult };
  exportVideo: { params: { id: string; format: ExportFormat }; result: ExportStartResult };
  exportResult: { params: { jobId: string }; result: ExportResultReply };
  markWelcomeSeen: { params: undefined; result: null };
  welcomeSeen: { params: undefined; result: boolean };
  close: { params: undefined; result: null };
}

export type HostMethod = keyof HostMethods;

export interface HostRequest {
  id: number;
  method: HostMethod;
  params?: unknown;
}

export type HostResponse = { id: number; result: unknown } | { id: number; error: string };

/** Host to main, unprompted. */
export interface HostEvent {
  event: "changed";
}

export type HostMessage = HostResponse | HostEvent;

export const isHostEvent = (m: HostMessage): m is HostEvent => "event" in m;
