// Socket.IO: painel (sessão de usuário) e players (credencial de tela), separados por organização.
// O realtime nunca é fonte de verdade — só avisa "há novidade" para o player buscar o manifesto.
// Salas: panel:<orgId> e players:<orgId>. Um cliente nunca recebe aviso de outro.
const { Server } = require('socket.io');
const repo = require('./repo');

const OFFLINE_AFTER_MS = 90_000;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function publicStatus(device) {
  return { id: device.id, online: device.online, lastSeenAt: device.lastSeenAt, status: device.status };
}

function attachRealtime(httpServer, { db, accounts, getAuth }) {
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
  const playerSockets = new Map(); // deviceId -> Set<socket>

  const notify = {
    // "há novidade" → os players da organização revalidam o manifesto (ETag torna isso barato)
    sync(orgId) {
      io.to(`players:${orgId}`).emit('sync');
    },
    panel(orgId, event, payload) {
      io.to(`panel:${orgId}`).emit(event, payload || {});
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

  // presença gravada no banco; o painel da organização recebe o novo status
  async function presence(device, fields) {
    const updated = await db.withOrg(device.orgId, (tx) => repo.updateDevicePresence(tx, device.id, fields));
    if (updated) notify.panel(device.orgId, 'device-status', publicStatus(updated));
    return updated;
  }
  const report = (err) => console.error('[realtime]', err.message);

  io.on('connection', async (socket) => {
    const { role, token } = socket.handshake.auth || {};
    try {
      if (role === 'panel') {
        const session = await accounts.validateSession(token);
        if (!session?.org || session.user.mustChangePassword) return socket.disconnect(true);
        socket.join(`panel:${session.org.id}`);
        return;
      }

      if (role === 'player') {
        const device = await getAuth().findDevice(token);
        if (!device) return socket.disconnect(true);
        socket.join(`players:${device.orgId}`);
        if (!playerSockets.has(device.id)) playerSockets.set(device.id, new Set());
        playerSockets.get(device.id).add(socket);

        socket.on('status', (s) => {
          presence(device, {
            lastSeenAt: Date.now(),
            status: {
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
            }
          }).catch(report);
        });

        socket.on('disconnect', () => {
          const set = playerSockets.get(device.id);
          if (!set) return;
          set.delete(socket);
          if (set.size) return;
          playerSockets.delete(device.id);
          presence(device, { online: false }).catch(report);
        });

        await presence(device, { online: true, lastSeenAt: Date.now() });
        return;
      }
    } catch (err) {
      report(err);
    }
    socket.disconnect(true);
  });

  // Marca offline quem sumiu sem desconectar (queda de energia, rede).
  const watchdog = setInterval(() => {
    db.system(async (tx) => (await tx.query(
      `UPDATE devices SET online = false
        WHERE online AND (last_seen_at IS NULL OR last_seen_at < $1) AND NOT (id = ANY($2))
        RETURNING *`,
      [new Date(Date.now() - OFFLINE_AFTER_MS), [...playerSockets.keys()]]
    )).rows).then((rows) => {
      for (const r of rows) notify.panel(r.org_id, 'device-status', publicStatus(repo.deviceFrom(r)));
    }).catch(report);
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
