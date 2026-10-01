import { MongoClient, type Collection, type Db, type ObjectId } from "mongodb";
import type { Config } from "./config.js";
import type { Role } from "./schemas.js";
import type { TimeSource } from "./pairing.js";

// Semua nilai ns disimpan sebagai string bilangan bulat (lihat time.ts).

export interface UserDoc {
  _id: ObjectId;
  username: string;
  name: string;
  role: Exclude<Role, "device">;
  passwordHash: string;
  disabled: boolean;
  createdAt: Date;
}

export interface LaneDoc {
  lane: string;
  teamId: string;
  bib: string | null;
  teamName: string | null;
  crewExpected: number | null;
}

export interface SessionDoc {
  _id: ObjectId;
  eventId: string;
  /** Division/Race/Initial di sts-timingsystem; null = belum ditautkan. */
  bucket: { divisionId: string; raceId: string; initialId: string } | null;
  raceCategory: "H2H" | "RX" | "DRR" | "SPRINT" | "SLALOM";
  heatId: string | null;
  label: string;
  lanes: LaneDoc[];
  cameraId: string;
  armed: boolean;
  status: "open" | "closed";
  calibrationOffsetNs: string;
  calibratedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface ImpulseDoc {
  _id: ObjectId;
  sessionId: ObjectId | null;
  groupId: ObjectId | null;
  bootId: string;
  seq: number;
  channel: "FINISH" | "START";
  deviceTime: string;
  deviceTimeNs: string;
  /** "device" = waktu dari payload RaceTime2; "pf-clock" = frame bare, waktu dari jam PF saat diterima. */
  timeBasis: "device" | "pf-clock";
  /** Revisi jam PF yang dipakai bila timeBasis "pf-clock". */
  pfClockRevision: number | null;
  serialLatencyNs: string | null;
  hostNs: string;
  /** Snapshot offset jam perangkat saat impuls diterima (null = belum sinkron). */
  deviceOffsetNs: string | null;
  receivedAt: Date;
}

export interface GroupDoc {
  _id: ObjectId;
  sessionId: ObjectId;
  impulseIds: ObjectId[];
  firstDeviceNs: string;
  lastDeviceNs: string;
  status: "collecting" | "extracting" | "ready";
  warnings: string[];
  createdAt: Date;
  extractRequestedAt: Date | null;
  /** Snapshot jam PF saat ekstraksi — dicetak di gambar, tidak berubah oleh kalibrasi ulang. */
  clock: ClockSnapshot | null;
}

export interface ClockSnapshot {
  mode: "auto" | "manual";
  /** Asal base offset: dikunci admin, heartbeat RaceTime2, atau jam lokal laptop (fallback). */
  source: "manual" | "racetime" | "host-local";
  revision: number;
  baseOffsetNs: string | null;
  trimNs: string;
  /** jam host − jam PF (basis RaceTime2); null = belum ada acuan jam. */
  effectiveOffsetNs: string | null;
}

/** Pengaturan jam Photo Finish — hanya admin yang boleh mengubah. */
export interface ClockSettingsDoc {
  _id: "settings";
  mode: "auto" | "manual";
  /** Offset yang dikunci admin (jam host − jam RaceTime2). */
  manualOffsetNs: string | null;
  /** Koreksi halus; positif = jam PF maju. */
  trimNs: string;
  revision: number;
  updatedBy: string;
  updatedAt: Date;
}

export interface CaptureDoc {
  _id: ObjectId;
  sessionId: ObjectId;
  groupId: ObjectId;
  cameraId: string;
  file: string;
  columnsFile: string;
  sha256: string;
  columnsSha256: string;
  fps: number;
  width: number;
  height: number;
  fromAgentNs: string;
  toAgentNs: string;
  agentOffsetNs: string;
  agentRttNs: string;
  /** Pengaturan jam PF yang dipakai saat rekaman dibuat (sama dengan yang dicetak di gambar). */
  clock: ClockSnapshot | null;
  createdAt: Date;
}

export interface CrossingDoc {
  _id: ObjectId;
  sessionId: ObjectId;
  groupId: ObjectId;
  captureId: ObjectId;
  column: number;
  rank: number;
  lane: string | null;
  teamId: string | null;
  bib: string | null;
  frameAgentNs: string;
  cameraTimeNs: string | null;
  impulseId: ObjectId | null;
  timeSource: TimeSource | "manual" | null;
  timeNs: string | null;
  finishTime: string | null;
  officialTime: string | null;
  warnings: string[];
  crewInBoat: number | null;
  crewExpected: number | null;
  upright: boolean | null;
  secondCrossing: boolean;
  status: "suggested" | "confirmed" | "disputed";
  revision: number;
  markedBy: string;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  deliveredRevision: number;
}

export interface ClockDoc {
  _id: "timing";
  bootId: string;
  deviceOffsetNs: string;
  samples: number;
  windowMs: number;
  hostNs: string;
  receivedAt: Date;
}

export interface AuditDoc {
  _id: ObjectId;
  seq: number;
  at: Date;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  prevHash: string;
  hash: string;
}

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  impulses: Collection<ImpulseDoc>;
  groups: Collection<GroupDoc>;
  captures: Collection<CaptureDoc>;
  crossings: Collection<CrossingDoc>;
  clock: Collection<ClockDoc>;
  clockSettings: Collection<ClockSettingsDoc>;
  audit: Collection<AuditDoc>;
}

export interface Database {
  client: MongoClient;
  db: Db;
  col: Collections;
}

export async function connectDb(cfg: Config): Promise<Database> {
  const client = new MongoClient(cfg.PF_MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db(cfg.PF_MONGO_DB);
  const col: Collections = {
    users: db.collection("pf_users"),
    sessions: db.collection("pf_sessions"),
    impulses: db.collection("pf_impulses"),
    groups: db.collection("pf_groups"),
    captures: db.collection("pf_captures"),
    crossings: db.collection("pf_crossings"),
    clock: db.collection("pf_clock"),
    clockSettings: db.collection("pf_clock_settings"),
    audit: db.collection("pf_audit"),
  };
  await Promise.all([
    col.users.createIndex({ username: 1 }, { unique: true }),
    col.sessions.createIndex({ eventId: 1, createdAt: -1 }),
    // Idempoten: impuls yang dikirim ulang (reconnect) tidak tercatat dua kali.
    col.impulses.createIndex({ bootId: 1, seq: 1 }, { unique: true }),
    col.impulses.createIndex({ sessionId: 1, deviceTimeNs: 1 }),
    col.groups.createIndex({ sessionId: 1, createdAt: -1 }),
    col.captures.createIndex({ groupId: 1 }),
    col.crossings.createIndex({ groupId: 1, rank: 1 }),
    col.crossings.createIndex({ status: 1, deliveredRevision: 1 }),
    col.audit.createIndex({ seq: 1 }, { unique: true }),
  ]);
  return { client, db, col };
}
