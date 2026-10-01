// Bentuk data dari API (lihat api/src/db.ts). ObjectId & ns tiba sebagai string.
export type Role = "admin" | "judge" | "operator" | "viewer";
export type RaceCategory = "H2H" | "RX" | "DRR" | "SPRINT" | "SLALOM";

export interface User { sub: string; name: string; role: Role }

export interface Lane { lane: string; teamId: string; bib: string | null; teamName: string | null; crewExpected: number | null }

export interface Bucket { divisionId: string; raceId: string; initialId: string }

export interface Session {
  _id: string; eventId: string; bucket: Bucket | null; raceCategory: RaceCategory; heatId: string | null; label: string;
  lanes: Lane[]; cameraId: string; armed: boolean; status: "open" | "closed";
  calibrationOffsetNs: string; calibratedAt: string | null; createdAt: string;
}

export interface Impulse { _id: string; groupId: string | null; seq: number; channel: string; deviceTime: string; timeBasis: "device" | "pf-clock"; deviceTimeNs: string; deviceOffsetNs: string | null }

export interface Group { _id: string; impulseIds: string[]; status: "collecting" | "extracting" | "ready"; warnings: string[]; createdAt: string }

export interface Capture { _id: string; groupId: string; cameraId: string; url: string; columnsUrl: string; width: number; height: number; fps: number; sha256: string }

export interface Crossing {
  _id: string; groupId: string; captureId: string; column: number; rank: number; lane: string | null; teamId: string | null; bib: string | null;
  impulseId: string | null; timeSource: "impulse" | "camera" | "manual" | null; finishTime: string | null; officialTime: string | null;
  warnings: string[]; crewInBoat: number | null; crewExpected: number | null; upright: boolean | null; secondCrossing: boolean;
  status: "suggested" | "confirmed" | "disputed"; revision: number; deliveredRevision: number;
}

export interface SessionDetail { session: Session; groups: Group[]; impulses: Impulse[]; captures: Capture[]; crossings: Crossing[] }
