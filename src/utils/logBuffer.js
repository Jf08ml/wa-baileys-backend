// Buffer circular de logs en memoria + bridge hacia Socket.IO
const MAX = 200;
const buffer = [];
let _io = null;

export function setIo(io) {
  _io = io;
}

export function pushLog(entry) {
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  if (_io) _io.emit("log", entry);
}

export function getRecentLogs() {
  return [...buffer];
}
