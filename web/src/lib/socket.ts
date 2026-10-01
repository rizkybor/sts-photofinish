import { io, type Socket } from "socket.io-client";
import { auth } from "./api";

let socket: Socket | null = null;

/** Satu koneksi per tab; token wajib (API menolak koneksi tanpa token). */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ auth: (cb) => cb({ token: auth.token }), transports: ["websocket"] });
  }
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
}
