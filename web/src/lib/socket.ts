import { reactive } from "vue";
import { io, type Socket } from "socket.io-client";
import { auth } from "./api";

let socket: Socket | null = null;

/** Status koneksi realtime — ditampilkan di navbar. */
export const realtime = reactive({ connected: false });

/** Satu koneksi per tab; token wajib (API menolak koneksi tanpa token). */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ auth: (cb) => cb({ token: auth.token }), transports: ["websocket"] });
    socket.on("connect", () => (realtime.connected = true));
    socket.on("disconnect", () => (realtime.connected = false));
  }
  return socket;
}

export function closeSocket() {
  socket?.close();
  socket = null;
  realtime.connected = false;
}
