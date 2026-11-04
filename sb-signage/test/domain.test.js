// Regras puras: resolução de playlist, fuso horário, versão do manifesto.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePlaylist, buildManifest } = require('../server/domain/manifest');
const { zonedParts } = require('../server/time');
const { inWindow } = require('../server/util');
const { etagMatches } = require('../server/routes/player');
const { emptyData } = require('../server/store');

const TZ = 'America/Sao_Paulo';

function fixture() {
  const data = emptyData();
  data.playlists.push(
    { id: 'pl-padrao', name: 'Padrão', items: [] },
    { id: 'pl-manha', name: 'Manhã', items: [] },
    { id: 'pl-noite', name: 'Noite', items: [] },
    { id: 'pl-grupo', name: 'Grupo', items: [] },
    { id: 'pl-vip', name: 'VIP', items: [] }
  );
  data.groups.push({ id: 'g1', name: 'Vitrines', playlistId: 'pl-grupo' });
  const device = { id: 'd1', name: 'Recepção', playlistId: 'pl-padrao', groupId: 'g1' };
  data.devices.push(device);
  return { data, device };
}

// 2026-11-04 (quarta) — horários de São Paulo (UTC-3) expressos em UTC
const at = (hhmmLocal, day = '2026-11-04') => new Date(`${day}T${hhmmLocal}:00-03:00`);

test('zonedParts usa o fuso configurado, não o do processo', () => {
  const instant = new Date('2026-11-05T02:30:00Z'); // 23:30 de 04/11 em São Paulo
  assert.deepEqual(zonedParts(instant, TZ), { date: '2026-11-04', hhmm: '23:30', day: 3 });
  assert.deepEqual(zonedParts(instant, 'UTC'), { date: '2026-11-05', hhmm: '02:30', day: 4 });
});

test('inWindow: janela normal, que cruza a meia-noite e de 24 h', () => {
  assert.equal(inWindow('09:00', '08:00', '18:00'), true);
  assert.equal(inWindow('18:00', '08:00', '18:00'), false, 'fim é exclusivo');
  assert.equal(inWindow('23:30', '22:00', '06:00'), true);
  assert.equal(inWindow('05:59', '22:00', '06:00'), true);
  assert.equal(inWindow('12:00', '22:00', '06:00'), false);
  assert.equal(inWindow('12:00', '00:00', '00:00'), true, 'início = fim significa o dia todo');
});

test('sem agenda: playlist da tela vence a do grupo; sem playlist própria, herda do grupo', () => {
  const { data, device } = fixture();
  assert.equal(resolvePlaylist(data, device, { now: at('10:00'), timeZone: TZ }).id, 'pl-padrao');
  device.playlistId = null;
  assert.equal(resolvePlaylist(data, device, { now: at('10:00'), timeZone: TZ }).id, 'pl-grupo');
  device.groupId = null;
  assert.equal(resolvePlaylist(data, device, { now: at('10:00'), timeZone: TZ }), null);
});

test('agenda ativa vence a playlist padrão; a de maior prioridade vence', () => {
  const { data, device } = fixture();
  data.schedules.push(
    { id: 's1', deviceId: 'd1', playlistId: 'pl-manha', days: [3], start: '08:00', end: '12:00', priority: 0 },
    { id: 's2', deviceId: 'd1', playlistId: 'pl-vip', days: [3], start: '10:00', end: '11:00', priority: 5 }
  );
  assert.equal(resolvePlaylist(data, device, { now: at('09:00'), timeZone: TZ }).id, 'pl-manha');
  assert.equal(resolvePlaylist(data, device, { now: at('10:30'), timeZone: TZ }).id, 'pl-vip');
  assert.equal(resolvePlaylist(data, device, { now: at('13:00'), timeZone: TZ }).id, 'pl-padrao');
  // quinta-feira: regra só vale na quarta
  assert.equal(resolvePlaylist(data, device, { now: at('09:00', '2026-11-05'), timeZone: TZ }).id, 'pl-padrao');
});

test('agenda noturna: "quarta 22:00→06:00" vai de quarta à noite até quinta de manhã', () => {
  const { data, device } = fixture();
  data.schedules.push({ id: 's1', deviceId: 'd1', playlistId: 'pl-noite', days: [3], start: '22:00', end: '06:00' });
  const playing = (now) => resolvePlaylist(data, device, { now, timeZone: TZ }).id;
  assert.equal(playing(at('23:00')), 'pl-noite');
  assert.equal(playing(at('02:00', '2026-11-05')), 'pl-noite', 'madrugada de quinta continua a noite de quarta');
  assert.equal(playing(at('06:00', '2026-11-05')), 'pl-padrao', 'fim é exclusivo');
  assert.equal(playing(at('02:00', '2026-11-04')), 'pl-padrao', 'madrugada de quarta pertence à terça');
  // servidor em UTC às 01:30Z = 22:30 em São Paulo: antes da correção, a agenda saía 3 h errada
  assert.equal(playing(new Date('2026-11-05T01:30:00Z')), 'pl-noite');
});

test('weeklyWindowActive: domingo 22:00→02:00 atravessa para segunda', () => {
  const { weeklyWindowActive } = require('../server/util');
  assert.equal(weeklyWindowActive([0], '22:00', '02:00', { day: 1, hhmm: '01:00' }), true);
  assert.equal(weeklyWindowActive([0], '22:00', '02:00', { day: 0, hhmm: '01:00' }), false);
  assert.equal(weeklyWindowActive([2], '00:00', '00:00', { day: 2, hhmm: '15:00' }), true);
});

test('versão do manifesto muda com o nome da tela e não muda sem alteração', () => {
  const { data, device } = fixture();
  const opts = { now: at('10:00'), timeZone: TZ };
  const v1 = buildManifest(data, device, opts).version;
  assert.equal(buildManifest(data, device, opts).version, v1);
  device.name = 'Recepção 2';
  assert.notEqual(buildManifest(data, device, opts).version, v1);
});

test('manifesto só inclui mídia pronta e usa o prefixo de CDN', () => {
  const { data, device } = fixture();
  data.media.push(
    { id: 'm1', name: 'a.mp4', type: 'video', status: 'ready', file: 'm1-abc.mp4', hls: null, duration: 30 },
    { id: 'm2', name: 'b.png', type: 'image', status: 'processing', file: null }
  );
  data.playlists[0].items = [{ mediaId: 'm1', duration: 10 }, { mediaId: 'm2', duration: 5 }];
  const m = buildManifest(data, device, { now: at('10:00'), timeZone: TZ, mediaBaseUrl: 'https://cdn.exemplo.com' });
  assert.equal(m.items.length, 1);
  assert.equal(m.items[0].url, 'https://cdn.exemplo.com/m/m1-abc.mp4');
  assert.equal(m.items[0].duration, null, 'vídeo toca até o fim');
  assert.equal(m.settings.timezone, TZ);
});

test('emergência: mídia pronta ou mensagem', () => {
  const { data, device } = fixture();
  data.emergency = { active: true, mediaId: null, message: 'EVACUAR', startedAt: 1 };
  assert.deepEqual(buildManifest(data, device, { timeZone: TZ }).emergency, { type: 'message', message: 'EVACUAR' });
});

test('If-None-Match aceita ETag com aspas, fraca, lista e sem aspas', () => {
  assert.equal(etagMatches('"abc"', 'abc'), true);
  assert.equal(etagMatches('W/"abc"', 'abc'), true);
  assert.equal(etagMatches('"x", "abc"', 'abc'), true);
  assert.equal(etagMatches('abc', 'abc'), true);
  assert.equal(etagMatches('"abd"', 'abc'), false);
  assert.equal(etagMatches(undefined, 'abc'), false);
});
