// Visão geral: números principais, o que pede atenção e o que está no ar agora.
import { state, deviceIssues, basePlaylistOf, mediaById, thumbUrl } from '../state.js';
import { esc, icon, fmtSize, fmtLong, fmtAgo, fmtNum, plural } from '../ui.js';

function kpi(label, iconName, value, foot, meter) {
  return `<div class="card kpi">
    <div class="kpi-label">${icon(iconName)}${esc(label)}</div>
    <div class="kpi-value">${value}</div>
    ${meter != null ? `<div class="meter"><i style="width:${Math.round(Math.min(1, meter) * 100)}%"></i></div>` : ''}
    <div class="kpi-foot">${foot}</div>
  </div>`;
}

function attentionItems() {
  const items = [];
  if (state.me?.defaultPassword) {
    items.push({ kind: 'warn', icon: 'key-round', text: 'Senha padrão em uso', href: '#settings', cta: 'Trocar' });
  }
  for (const dev of state.devices) {
    for (const issue of deviceIssues(dev)) {
      if (issue.kind === 'info' && issue.text.startsWith('baixando')) continue;
      items.push({
        kind: issue.kind, icon: issue.text === 'offline' ? 'wifi-off' : 'monitor',
        text: `${dev.name}: ${issue.text}${issue.text === 'offline' ? ` (${fmtAgo(dev.lastSeenAt)})` : ''}`,
        href: '#screens', cta: 'Ver'
      });
    }
  }
  const failed = state.media.filter((m) => m.status === 'failed');
  if (failed.length) {
    items.push({ kind: 'danger', icon: 'circle-alert', text: `${plural(failed.length, 'mídia falhou', 'mídias falharam')} no processamento`, href: '#media', cta: 'Ver' });
  }
  return items;
}

export default {
  title: 'Visão geral',
  subtitle: () => 'Situação das telas e do conteúdo',
  deps: ['overview', 'devices', 'device-status', 'media', 'playlists', 'groups', 'schedules', 'me'],
  actions: () => `
    <a class="btn" href="#media">${icon('upload')}Enviar mídia</a>
    <a class="btn btn-primary" href="#screens">${icon('plus')}Parear tela</a>`,

  render(root) {
    const o = state.overview;
    if (!o) {
      root.innerHTML = `<p class="muted">${icon('loader-circle', 'spin')} Carregando…</p>`;
      return;
    }
    const online = state.devices.filter((d) => d.online).length;
    const total = state.devices.length;
    const attention = attentionItems();

    const nowPlaying = state.devices.map((dev) => {
      const m = dev.status?.mediaId ? mediaById(dev.status.mediaId) : null;
      const thumb = thumbUrl(m);
      const { playlist } = basePlaylistOf(dev);
      let label;
      if (!dev.online) label = `<span class="badge badge-danger">${icon('wifi-off')}offline</span>`;
      else if (dev.status?.poweredOff) label = `<span class="badge">${icon('power')}desligada (agenda)</span>`;
      else label = `<span class="badge badge-ok"><span class="dot dot-ok"></span>no ar</span>`;
      return `<div class="list-item">
        <div class="thumb-mini" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : icon('tv')}</div>
        <div class="grow">
          <div class="row"><b class="truncate">${esc(dev.name)}</b>${label}</div>
          <div class="small subtle truncate">${dev.online && dev.status?.playing ? `Exibindo ${esc(dev.status.playing)}` : playlist ? `Playlist ${esc(playlist.name)}` : 'Sem playlist'}</div>
        </div>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="kpis">
        ${kpi('Telas online', 'monitor', `${online}<small>/${total}</small>`, total ? `${total - online} offline` : 'nenhuma tela pareada', total ? online / total : null)}
        ${kpi('Mídias', 'images', fmtNum(o.media.total), `${fmtSize(o.media.bytes) || '0 KB'} em disco${o.media.processing ? ` · ${o.media.processing} processando` : ''}`)}
        ${kpi('Exibições hoje', 'chart-column', fmtNum(o.playsToday), `${fmtLong(o.secondsToday)} no ar`)}
        ${kpi('Playlists', 'list-video', fmtNum(o.playlists), `${plural(o.schedules, 'regra de agenda', 'regras de agenda')}`)}
      </div>

      <div class="grid grid-2">
        <section class="card">
          <div class="card-head"><h2>Agora nas telas</h2><a class="btn btn-ghost btn-sm" href="#screens">Gerenciar ${icon('chevron-right')}</a></div>
          ${total ? `<div class="list">${nowPlaying}</div>` : `
            <div class="card-body"><div class="empty">${icon('tv')}<h3>Nenhuma tela pareada</h3>
              <p>Abra <code>${esc(location.origin)}/player</code> na TV e informe o código em <b>Telas → Parear tela</b>.</p></div></div>`}
        </section>

        <section class="card">
          <div class="card-head"><h2>Pede atenção</h2>${attention.length ? `<span class="badge badge-warn">${attention.length}</span>` : ''}</div>
          ${attention.length ? `<div class="list">${attention.map((a) => `
            <div class="list-item">
              <span class="badge badge-${a.kind === 'danger' ? 'danger' : a.kind === 'warn' ? 'warn' : 'info'}">${icon(a.icon)}</span>
              <span class="grow">${esc(a.text)}</span>
              <a class="btn btn-sm" href="${a.href}">${esc(a.cta)}</a>
            </div>`).join('')}</div>` : `
            <div class="card-body"><div class="empty" style="padding:32px 16px">${icon('circle-check')}<h3>Tudo certo</h3><p>Nenhuma tela ou mídia com problema.</p></div></div>`}
        </section>
      </div>`;
  }
};
