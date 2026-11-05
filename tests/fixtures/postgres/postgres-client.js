// Minimal PostgreSQL wire client for this dependency-free acceptance fixture.
// Only supports trust authentication on the disposable internal database.
import net from 'node:net';
export async function connect() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://harness@postgres:5432/harness');
  if (url.hostname !== 'postgres' || url.pathname !== '/harness') throw new Error('Fixture refuses a non-disposable database endpoint');
  const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 5432) });
  let buffer = Buffer.alloc(0); let pending; let rows = [];
  const wait = () => new Promise((resolve, reject) => { pending = { resolve, reject }; });
  const ready = wait();
  socket.setTimeout(3000, () => socket.destroy(new Error('PostgreSQL fixture timeout')));
  socket.on('error', error => { pending?.reject(new Error(`DATABASE_URL PostgreSQL unavailable: ${error.message}`)); pending = undefined; });
  socket.on('close', () => { pending?.reject(new Error('PostgreSQL connection closed before ReadyForQuery')); pending = undefined; });
  socket.on('connect', () => {
    const fields = Buffer.from(`user\0${decodeURIComponent(url.username) || 'harness'}\0database\0harness\0\0`);
    const packet = Buffer.alloc(8 + fields.length); packet.writeInt32BE(packet.length); packet.writeInt32BE(196608, 4); fields.copy(packet, 8); socket.write(packet);
  });
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1) + 1) {
      const type = String.fromCharCode(buffer[0]); const length = buffer.readInt32BE(1); const payload = buffer.subarray(5, length + 1); buffer = buffer.subarray(length + 1);
      if (type === 'R' && payload.readInt32BE(0) !== 0) socket.destroy(new Error('Fixture only supports disposable trust authentication'));
      if (type === 'E') { pending?.reject(new Error(`PostgreSQL query failed: ${payload.toString()}`)); pending = undefined; }
      if (type === 'D') {
        const values = []; let offset = 2;
        for (let index = 0; index < payload.readInt16BE(0); index++) { const size = payload.readInt32BE(offset); offset += 4; values.push(size === -1 ? null : payload.subarray(offset, offset + size).toString()); if (size !== -1) offset += size; }
        rows.push(values);
      }
      if (type === 'Z') { pending?.resolve(rows); pending = undefined; rows = []; }
    }
  });
  try { await ready; } catch (error) { socket.destroy(); throw error; }
  return {
    async query(sql) {
      const complete = wait(); const text = Buffer.from(sql + '\0'); const packet = Buffer.alloc(5 + text.length); packet[0] = 81; packet.writeInt32BE(4 + text.length, 1); text.copy(packet, 5); socket.write(packet); return complete;
    },
    close() { socket.destroy(); },
  };
}
