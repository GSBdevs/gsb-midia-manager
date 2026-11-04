// Socket.IO: painel (sessão de usuário) e players (credencial de tela).
// O realtime nunca é fonte de verdade — só avisa "há novidade" para o player buscar o manifesto.
const { Server } = require('socket.io');

const OFFLINE_AFTER_MS = 90_000;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function publicStatus(device) {
  return {
    id: device.id,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
    status: device.status
  };
}

function attachRealtime(httpServer, { store, auth }) {
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
  const playerSockets = new Map(); // deviceId -> Set<socket>

  const notify = {
    // "há novidade" → todos os players revalidam o manifesto (ETag torna isso barato)
    sync() {
      io.to('players').emit('sync');
    },
    panel(event, payload) {
      io.to('panel').emit(event, payload || {});
    },
    command(deviceId, cmd) {
      const sockets = playerSockets.get(deviceId);
      if (!sockets || !sockets.size) return false;
      for (const s of sockets) s.emit('command', cmd);
      return true;
    },
    // tela removida no painel: avisa e derruba as conexões dela
    unpair(deviceId) {
      const sockets = playerSockets.get(deviceId);
      if (!sockets) return;
      for (const s of sockets) {
        s.emit('command', { type: 'unpaired' });
        s.disconnect(true);
      }
      playerSockets.delete(deviceId);
    },
    isConnected: (deviceId) => playerSockets.has(deviceId)
  };

  io.on('connection', (socket) => {
    const { role, token } = socket.handshake.auth || {};

    if (role === 'panel') {
      if (!auth.validateSession(token)) return socket.disconnect(true);
      socket.join('panel');
      return;
    }

    if (role === 'player') {
      const device = auth.findDevice(token);
      if (!device) return socket.disconnect(true);
      socket.join('players');

      if (!playerSockets.has(device.id)) playerSockets.set(device.id, new Set());
      playerSockets.get(device.id).add(socket);

      device.online = true;
      device.lastSeenAt = Date.now();
      store.save();
      notify.panel('device-status', publicStatus(device));

      socket.on('status', (s) => {
        if (!store.data.devices.includes(device)) return; // removida enquanto conectada
        device.status = {
          playing: str(s?.playing, 200),
          mediaId: str(s?.mediaId, 40),
          cached: num(s?.cached),
          missing: num(s?.missing),
          cacheErrors: num(s?.cacheErrors),
          lastError: str(s?.lastError, 200),
          storageUsage: num(s?.storageUsage),
          storageQuota: num(s?.storageQuota),
          persisted: typeof s?.persisted === 'boolean' ? s.persisted : null,
          emergency: !!s?.emergency,
          poweredOff: !!s?.poweredOff,
          version: str(s?.version, 64),
          userAgent: str(socket.handshake.headers['user-agent'], 200)
        };
        device.lastSeenAt = Date.now();
        store.save();
        notify.panel('device-status', publicStatus(device));
      });

      socket.on('disconnect', () => {
        const set = playerSockets.get(device.id);
        if (!set) return;
        set.delete(socket);
        if (set.size) return;
        playerSockets.delete(device.id);
        if (!store.data.devices.includes(device)) return;
        device.online = false;
        store.save();
        notify.panel('device-status', publicStatus(device));
      });
      return;
    }

    socket.disconnect(true);
  });

  // Marca offline quem sumiu sem desconectar (queda de energia, rede).
  const watchdog = setInterval(() => {
    for (const device of store.data.devices) {
      if (device.online && device.lastSeenAt && Date.now() - device.lastSeenAt > OFFLINE_AFTER_MS &&
          !playerSockets.has(device.id)) {
        device.online = false;
        store.save();
        notify.panel('device-status', publicStatus(device));
      }
    }
  }, 30_000);
  watchdog.unref();

  return {
    io,
    notify,
    close() {
      clearInterval(watchdog);
      io.close();
    }
  };
}

module.exports = { attachRealtime };
