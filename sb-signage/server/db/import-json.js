// Importa o data.json (instalação de um cliente só) para uma organização do banco multiusuário.
//
// Preserva IDs, nomes de arquivo de mídia e o hash da credencial de cada tela: as TVs já
// pareadas continuam funcionando sem parear de novo. A senha do painel vira a senha do dono.
const { AccountError } = require('../accounts');

const ts = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date());

async function importFromJson(db, accounts, data, { orgName, ownerEmail, ownerName = '', ownerPassword } = {}) {
  if (!orgName) throw new AccountError('informe o nome da organização');
  if (!ownerEmail) throw new AccountError('informe o e-mail do dono');

  const org = await accounts.createOrganization({ name: orgName });

  // senha: a do painel atual (mesmo formato scrypt) > a informada > "admin" com troca obrigatória
  let passwordHash = null;
  let mustChangePassword = false;
  if (data.auth?.passwordHash && data.auth?.salt) {
    passwordHash = `scrypt$${data.auth.salt}$${data.auth.passwordHash}`;
  }
  const owner = await accounts.createUser({
    email: ownerEmail,
    name: ownerName,
    password: ownerPassword || 'admin1234',
    passwordHash: passwordHash || undefined,
    mustChangePassword: !passwordHash && !ownerPassword ? (mustChangePassword = true) : false
  });
  await accounts.setMembership(org.id, owner.id, 'owner');

  const counts = await db.withOrg(org.id, async (tx) => {
    const s = data.settings || {};
    await tx.query(
      `UPDATE org_settings SET brand_name = $2, accent = $3, theme = $4, density = $5, logo = $6, emergency = $7
        WHERE org_id = $1`,
      [org.id, s.brandName === 'SB Signage' || !s.brandName ? 'SB Mídias' : s.brandName,
        s.accent || '#ffd60a', s.theme || 'dark', s.density || 'comfortable', s.logo || null,
        data.emergency?.active ? JSON.stringify(data.emergency) : null]
    );

    const mediaIds = new Set();
    for (const m of data.media || []) {
      const { id, name, type, status, file, thumb, hls, url, size, width, height, duration, error, createdAt, ...rest } = m;
      await tx.query(
        `INSERT INTO media (id, org_id, name, type, status, file, thumb, hls, url, size, width, height, duration, error, meta, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, org.id, name, type, status, file || null, thumb || null, hls || null, url || null,
          size ?? null, width ?? null, height ?? null, duration ?? null, error || null, JSON.stringify(rest), ts(createdAt)]
      );
      mediaIds.add(id);
    }

    let items = 0;
    for (const p of data.playlists || []) {
      await tx.query('INSERT INTO playlists (id, org_id, name, created_at) VALUES ($1, $2, $3, $4)',
        [p.id, org.id, p.name, ts(p.createdAt)]);
      let position = 0;
      for (const it of p.items || []) {
        if (!mediaIds.has(it.mediaId)) continue; // item apontando para mídia apagada
        await tx.query(
          'INSERT INTO playlist_items (org_id, playlist_id, position, media_id, duration) VALUES ($1, $2, $3, $4, $5)',
          [org.id, p.id, position++, it.mediaId, Math.min(3600, Math.max(1, it.duration || 10))]
        );
        items++;
      }
    }

    for (const g of data.groups || []) {
      await tx.query('INSERT INTO device_groups (id, org_id, name, playlist_id, created_at) VALUES ($1, $2, $3, $4, $5)',
        [g.id, org.id, g.name, g.playlistId || null, ts(g.createdAt)]);
    }

    for (const d of data.devices || []) {
      if (!d.tokenHash) continue; // tela sem credencial (dados antigos corrompidos) não é importável
      await tx.query(
        `INSERT INTO devices (id, org_id, name, token_hash, playlist_id, group_id, orientation, fit, volume, muted,
                              overlay, power_schedule, status, last_seen_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [d.id, org.id, d.name, d.tokenHash, d.playlistId || null, d.groupId || null, d.orientation || 0,
          d.fit === 'cover' ? 'cover' : 'contain', d.volume ?? 100, !!d.muted,
          JSON.stringify(d.overlay || { ticker: '', showClock: false }),
          d.powerSchedule ? JSON.stringify(d.powerSchedule) : null, d.status ? JSON.stringify(d.status) : null,
          d.lastSeenAt ? ts(d.lastSeenAt) : null, ts(d.createdAt)]
      );
    }

    for (const r of data.schedules || []) {
      await tx.query(
        `INSERT INTO schedules (id, org_id, device_id, playlist_id, days, start_hhmm, end_hhmm, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, org.id, r.deviceId, r.playlistId, r.days, r.start, r.end, r.priority || 0]
      );
    }

    await tx.query(
      'INSERT INTO audit_log (org_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [org.id, owner.id, 'import.json', JSON.stringify({ media: mediaIds.size })]
    );

    return {
      media: mediaIds.size,
      playlists: (data.playlists || []).length,
      items,
      groups: (data.groups || []).length,
      devices: (data.devices || []).filter((d) => d.tokenHash).length,
      schedules: (data.schedules || []).length
    };
  });

  return { org, owner, mustChangePassword, counts };
}

module.exports = { importFromJson };
