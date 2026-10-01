import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "./schemas.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Principal {
  sub: string;
  name: string;
  role: Role;
  /** Hanya untuk role "device". */
  deviceKind?: "timing" | "agent";
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function issueToken(p: Principal, secret: string, expiresIn: string): string {
  return jwt.sign(p, secret, { algorithm: "HS256", expiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string, secret: string): Principal {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  if (typeof decoded !== "object" || !decoded.sub || !decoded.role) throw new Error("Token tidak valid");
  return { sub: decoded.sub, name: decoded.name, role: decoded.role, deviceKind: decoded.deviceKind };
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? m[1]!.trim() : null;
}

/**
 * Hierarki: admin ⊇ judge ⊇ operator ⊇ viewer. "device" terpisah — perangkat
 * tidak pernah mewarisi hak pengguna dan sebaliknya.
 */
const RANK: Record<Exclude<Role, "device">, number> = { viewer: 0, operator: 1, judge: 2, admin: 3 };

export function allows(actual: Role, required: Role): boolean {
  if (required === "device" || actual === "device") return actual === required;
  return RANK[actual] >= RANK[required];
}

export function makeGuards(secret: string) {
  function authenticate(req: FastifyRequest): Principal | null {
    const token = bearer(req.headers.authorization);
    if (!token) return null;
    try {
      return verifyToken(token, secret);
    } catch {
      return null;
    }
  }

  return {
    authenticate,
    require(role: Role, deviceKind?: Principal["deviceKind"]) {
      return async (req: FastifyRequest, reply: FastifyReply) => {
        const p = authenticate(req);
        if (!p) return reply.code(401).send({ error: "Perlu login" });
        if (!allows(p.role, role) || (deviceKind && p.deviceKind !== deviceKind)) {
          return reply.code(403).send({ error: "Akses ditolak" });
        }
        req.principal = p;
      };
    },
  };
}
