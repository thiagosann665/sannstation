'use strict';
// Amigos: painel lateral (quem está online e jogando), pedidos, página do amigo (atividade e biblioteca),
// chat com convite para jogar e configuração do servidor (Firebase). Os dados vêm de /api/friends,
// que o app sincroniza com o Firebase a cada 25 s.

S.fr = { configured: false };
S.frSince = 0;
S.frLib = {}; // uid -> { at, data }
S.chat = null; // { uid, msgs, last, timer }

const FR_STATE = {
  playing: { label: 'Jogando', cls: 'playing' },
  online: { label: 'Online', cls: 'online' },
  away: { label: 'Ausente', cls: 'away' },
  offline: { label: 'Offline', cls: 'offline' },
};
const friendById = (uid) => (S.fr.friends || []).find((f) => f.uid === uid);
const frPrefs = () => { try { return JSON.parse(localStorage.getItem('sannstation-friends') || '{}'); } catch { return {}; } };
const saveFrPrefs = (p) => { try { localStorage.setItem('sannstation-friends', JSON.stringify({ ...frPrefs(), ...p })); } catch { /* sem storage */ } };

function hueOf(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function avatarHtml(person, size = '') {
  const state = person.state ? ` st-${FR_STATE[person.state]?.cls || 'offline'}` : '';
  return `<span class="fr-avatar ${size}${state}" style="--h:${hueOf(person.uid || person.name)}">${esc(person.avatar || '🎮')}</span>`;
}
function minutesSince(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}
function friendStatus(f) {
  if (f.state === 'playing' && f.game) return `${esc(f.game.n)}${f.since ? ` · ${minutesSince(f.since)}` : ''}`;
  if (f.state === 'offline') return f.lastSeen ? `Visto ${ago(Math.floor(f.lastSeen / 1000))}` : 'Offline';
  return FR_STATE[f.state]?.label || 'Online';
}

// Jogo do amigo -> jogo meu com o mesmo nome (e console), para mostrar a capa e o botão Jogar.
function myMatch(item) {
  const key = normTitle(item.n);
  if (!key) return null;
  return S.games.find((g) => normTitle(g.name) === key
    && (!item.c || !(g.consoleId || emuById(g.emulatorId)?.consoleId) || (g.consoleId || emuById(g.emulatorId)?.consoleId) === item.c)) || null;
}
function gameThumb(item, cls = '') {
  const mine = myMatch(item);
  if (mine?.cover) return `<img class="fr-thumb ${cls}" src="${coverUrl(mine)}" alt="">`;
  const initials = String(item.n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<span class="fr-thumb ph ${cls}" style="--h:${hueOf(item.n)}">${esc(initials)}</span>`;
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(okMsg);
}

// ------------------------------------------------------------------ dados e avisos

async function loadFriends({ sync = false } = {}) {
  let st;
  try {
    st = await api(sync ? '/friends/sync' : `/friends?since=${S.frSince}`, sync ? {} : undefined);
  } catch { return; }
  applyFriends(st);
}

function applyFriends(st) {
  const firstLoad = S.fr.eventSeq === undefined;
  S.fr = st;
  if (!firstLoad) (st.events || []).filter((e) => e.id > S.frSince).forEach(showFriendEvent); // cada aviso aparece uma vez só
  S.frSince = Math.max(S.frSince, st.eventSeq || 0);
  renderFriendsChrome();
  if (S.view === 'friend' && !$('#modalRoot').childElementCount) refreshFriendView();
  if (S.view === 'home' && !S.selected && !$('#modalRoot').childElementCount) {
    const box = $('#homeFriends');
    if (box) box.outerHTML = homeFriendsHtml();
  }
}

function showFriendEvent(e) {
  const chatOpen = S.chat?.uid === e.uid;
  let el = null;
  if (e.type === 'request') el = toast(`👋 ${e.name} quer ser seu amigo. Abra a lista de amigos para aceitar.`, false, 8000);
  if (e.type === 'accepted') el = toast(`🤝 ${e.name} aceitou seu pedido de amizade!`, false, 7000);
  if (e.type === 'online' && frPrefs().notifyOnline !== false) el = toast(`🟢 ${e.name} está online`);
  if (e.type === 'playing' && frPrefs().notifyPlaying !== false) el = toast(`🎮 ${e.name} começou a jogar ${e.game}`, false, 6000);
  if (e.type === 'message' && !chatOpen) {
    el = toast(e.inv ? `🎮 ${e.name} convidou você para jogar ${e.inv.n}` : `💬 ${e.name}: ${e.text}`, false, 8000);
  }
  if (el && e.uid && e.type !== 'request') {
    el.classList.add('clickable');
    el.addEventListener('click', () => (e.type === 'message' ? openChat(e.uid) : openFriend(e.uid)));
  }
  if (el && e.type === 'request') {
    el.classList.add('clickable');
    el.addEventListener('click', () => toggleFriendsPanel(true));
  }
}

// ------------------------------------------------------------------ botão e painel

function renderFriendsChrome() {
  const fr = S.fr;
  const btn = $('#friendsBtn');
  const online = (fr.friends || []).filter((f) => f.state !== 'offline').length;
  const alerts = (fr.requests || []).length + (fr.friends || []).filter((f) => f.unread).length;
  btn.innerHTML = `👥<span class="fb-n">${fr.configured && online ? online : ''}</span>${alerts ? `<span class="fb-badge">${alerts}</span>` : ''}`;
  btn.title = fr.configured ? `Amigos (${online} online)` : 'Amigos';
  btn.classList.toggle('on', document.body.classList.contains('fr-open'));
  const panel = $('#friendsPanel');
  // Não redesenha enquanto a pessoa digita um código no painel (perderia o texto).
  const typing = panel.contains(document.activeElement) && document.activeElement.matches('input, textarea') && document.activeElement.value;
  if (document.body.classList.contains('fr-open') && !typing) panel.innerHTML = friendsPanelHtml();
}

function toggleFriendsPanel(force) {
  const open = force ?? !document.body.classList.contains('fr-open');
  document.body.classList.toggle('fr-open', open);
  saveFrPrefs({ panel: open });
  $('#friendsPanel').innerHTML = open ? friendsPanelHtml() : '';
  renderFriendsChrome();
  if (open && S.fr.configured) loadFriends({ sync: true });
}

function friendsPanelHtml() {
  const fr = S.fr;
  if (!fr.configured) {
    return `<div class="fp-head"><b>Amigos</b><button class="fp-x" data-action="fr-panel" title="Fechar">✕</button></div>
      <div class="fp-empty">
        <div class="big">👥</div>
        <h3>Jogue com seus amigos</h3>
        <p>Veja quem está online e o que está jogando, a atividade e a biblioteca deles, e converse dentro da SannStation.</p>
        ${fr.defaultServer ? '<button class="btn primary" data-action="fr-setup" data-tab="default">Entrar</button>'
          : `<button class="btn primary" data-action="fr-setup" data-tab="invite">Recebi um convite</button>
             <button class="btn" data-action="fr-setup" data-tab="server">Criar o servidor (uma vez)</button>`}
        <p class="hint">${fr.defaultServer ? '' : 'Só uma pessoa do grupo cria o servidor (grátis, no Firebase). Os outros entram pelo convite dela.'}</p>
      </div>`;
  }
  const me = fr.me;
  const groups = [['playing', 'Jogando agora'], ['online', 'Online'], ['away', 'Ausente'], ['offline', 'Offline']];
  const row = (f) => `<div class="fp-friend ${f.uid === S.friendUid && S.view === 'friend' ? 'sel' : ''}" data-action="fr-open" data-uid="${esc(f.uid)}">
      ${avatarHtml(f)}
      <div class="fp-info"><div class="fp-name">${esc(f.name)}</div><div class="fp-sub ${f.state}">${friendStatus(f)}</div></div>
      ${f.unread ? '<span class="fp-unread" title="Mensagem nova"></span>' : ''}
      <button class="fp-chat" data-action="fr-chat" data-uid="${esc(f.uid)}" title="Conversar">💬</button>
    </div>`;
  return `<div class="fp-head"><b>Amigos</b>
      <button class="fp-x" data-action="fr-refresh" title="Atualizar">⟳</button>
      <button class="fp-x" data-action="fr-panel" title="Fechar">✕</button></div>
    <div class="fp-me">
      <button class="fp-avatar-btn" data-action="fr-avatar" title="Trocar avatar">${avatarHtml({ ...me, state: Object.keys(S.running).length && me.shareGame ? 'playing' : 'online' }, 'big')}</button>
      <div class="fp-info"><div class="fp-name">${esc(me.name)}</div>
        <div class="fp-code">Seu código: <b>${esc(me.code)}</b> <button class="linklike" data-action="fr-copy-code">copiar</button></div></div>
    </div>
    <div class="fp-add">
      <input class="input" id="frAddInput" placeholder="Código ou convite do amigo" autocomplete="off">
      <button class="btn small primary" data-action="fr-add">Adicionar</button>
    </div>
    <button class="btn small fp-invite" data-action="fr-invite">📨 Copiar convite para um amigo</button>
    ${fr.error ? `<div class="fp-error">⚠ ${esc(fr.error)}</div>` : ''}
    ${(fr.requests || []).length ? `<div class="fp-group"><div class="fp-gtitle">PEDIDOS DE AMIZADE</div>${fr.requests.map((r) => `<div class="fp-req">
        ${avatarHtml(r)}<div class="fp-info"><div class="fp-name">${esc(r.name)}</div><div class="fp-sub">${esc(r.code)}</div></div>
        <button class="btn small primary" data-action="fr-accept" data-uid="${esc(r.uid)}">Aceitar</button>
        <button class="btn small ghost" data-action="fr-decline" data-uid="${esc(r.uid)}" title="Recusar">✕</button></div>`).join('')}</div>` : ''}
    ${(fr.sent || []).length ? `<div class="fp-group"><div class="fp-gtitle">AGUARDANDO RESPOSTA</div>${fr.sent.map((s) => `<div class="fp-req">
        <span class="fr-avatar">⏳</span><div class="fp-info"><div class="fp-sub">Pedido para ${esc(s.code)}</div></div>
        <button class="btn small ghost" data-action="fr-cancel" data-uid="${esc(s.uid)}">Cancelar</button></div>`).join('')}</div>` : ''}
    ${groups.map(([st, title]) => {
      const list = (fr.friends || []).filter((f) => f.state === st);
      return list.length ? `<div class="fp-group"><div class="fp-gtitle">${title.toUpperCase()} <span>${list.length}</span></div>${list.map(row).join('')}</div>` : '';
    }).join('')}
    ${!(fr.friends || []).length && !(fr.requests || []).length ? `<p class="fp-hint">Nenhum amigo ainda. Mande seu código <b>${esc(me.code)}</b> ou o convite para alguém que usa a SannStation.</p>` : ''}`;
}

// ------------------------------------------------------------------ configuração

function friendsSetupModal(tab = 'invite') {
  const fr = S.fr;
  if (tab === 'default' && !fr.defaultServer) tab = 'invite';
  const m = openModal(`
    <h2>Amigos na SannStation</h2>
    <div class="seg">
      ${fr.defaultServer ? `<button data-tab="default" class="${tab === 'default' ? 'on' : ''}">Entrar</button>` : ''}
      <button data-tab="invite" class="${tab === 'invite' ? 'on' : ''}">Recebi um convite</button>
      <button data-tab="server" class="${tab === 'server' ? 'on' : ''}">Criar o servidor</button>
    </div>
    <form class="form" id="frSetup">
      <label>Seu nome para os amigos <input name="name" maxlength="40" required value="${esc(frPrefs().name || '')}" placeholder="ex.: Thiago"></label>
      <div data-pane="default"><p class="hint">Este app já vem com um servidor de amigos. É só escolher seu nome.</p></div>
      <div data-pane="invite">
        <label>Convite do seu amigo <textarea name="invite" rows="3" placeholder="Cole aqui o convite (começa com SANN1.)"></textarea></label>
        <p class="hint">Peça para quem já usa os amigos clicar em <b>Copiar convite para um amigo</b> e te mandar. O convite já traz o servidor: você não precisa configurar nada.</p>
      </div>
      <div data-pane="server">
        <ol class="fr-steps">
          <li>Abra o <a href="https://console.firebase.google.com/" target="_blank" rel="noopener">console do Firebase ↗</a> e clique em <b>Criar projeto</b> (o Google Analytics pode ficar desligado). É grátis e não pede cartão.</li>
          <li><b>Criação → Authentication → Vamos começar → Anônimo → Ativar → Salvar.</b></li>
          <li><b>Criação → Realtime Database → Criar banco de dados</b> (local à sua escolha, <b>modo bloqueado</b>). Na aba <b>Regras</b>, apague tudo, cole as regras da SannStation e clique em <b>Publicar</b>.
            <button type="button" class="btn small" id="frCopyRules">📋 Copiar regras</button></li>
          <li>Na engrenagem <b>⚙ → Configurações do projeto → Seus apps</b>, clique em <b>&lt;/&gt;</b> (Web), dê um nome e registre. Copie o bloco <code>firebaseConfig</code> e cole abaixo.</li>
        </ol>
        <label>firebaseConfig <textarea name="config" rows="6" placeholder='const firebaseConfig = {&#10;  apiKey: "AIza…",&#10;  databaseURL: "https://…firebaseio.com",&#10;  …'></textarea></label>
        <label>databaseURL (só se não vier no bloco acima) <input name="databaseURL" placeholder="https://seu-projeto-default-rtdb.firebaseio.com"></label>
        <p class="hint">A apiKey do Firebase não é secreta: quem protege os dados são as regras. Depois, seus amigos entram só com o convite.</p>
      </div>
      <div class="actions">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn primary" type="submit" id="frGo">Conectar</button>
      </div>
    </form>`, true);
  const form = $('#frSetup', m);
  const show = (t) => {
    tab = t;
    $$('[data-pane]', m).forEach((p) => { p.style.display = p.dataset.pane === t ? '' : 'none'; });
    $$('.seg button', m).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#frGo', m).textContent = { default: 'Entrar', invite: 'Entrar com o convite', server: 'Conectar ao Firebase' }[t];
  };
  $$('.seg button', m).forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  $('#frCopyRules', m).addEventListener('click', async () => copyText((await api('/friends/rules')).rules, 'Regras copiadas. Cole na aba Regras do Realtime Database e clique em Publicar.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    saveFrPrefs({ name });
    const go = $('#frGo', m);
    go.disabled = true;
    go.textContent = 'Conectando…';
    const body = tab === 'invite' ? ['/friends/join', { invite: form.elements.invite.value, name }]
      : tab === 'default' ? ['/friends/setup', { useDefault: true, name }]
        : ['/friends/setup', { config: form.elements.config.value, databaseURL: form.elements.databaseURL.value, name }];
    const st = await act(() => api(...body));
    go.disabled = false;
    show(tab);
    if (!st) return;
    closeModal();
    applyFriends(st);
    toggleFriendsPanel(true);
    toast(tab === 'invite' ? `Pronto! Pedido de amizade enviado para ${st.result?.status === 'accepted' ? 'seu amigo (já aceito)' : 'seu amigo'}.`
      : 'Amigos ativados! Clique em “Copiar convite para um amigo” e mande para quem você quiser.', false, 8000);
  });
  show(tab);
}

function avatarPicker() {
  const m = openModal(`<h2>Seu avatar</h2>
    <div class="avatar-grid">${(S.fr.avatars || []).map((a) => `<button class="${a === S.fr.me.avatar ? 'on' : ''}" data-av="${esc(a)}">${esc(a)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" data-close>Fechar</button></div>`);
  $$('[data-av]', m).forEach((b) => b.addEventListener('click', async () => {
    const st = await act(() => api('/friends/profile', { avatar: b.dataset.av }, 'PUT'));
    if (st) { closeModal(); applyFriends(st); }
  }));
}

// ------------------------------------------------------------------ ações

async function friendsAction(kind, uid) {
  let st;
  if (kind === 'add') {
    const input = $('#frAddInput');
    const code = input?.value.trim();
    if (!code) return toast('Cole o código ou o convite do seu amigo.', true);
    st = await act(() => api('/friends/add', { code }));
    if (st) {
      input.value = '';
      toast(st.result?.status === 'accepted' ? '🤝 Vocês agora são amigos!' : 'Pedido de amizade enviado. Assim que seu amigo aceitar, ele aparece aqui.', false, 6000);
    }
  } else if (kind === 'remove') {
    const f = friendById(uid);
    if (!confirm(`Desfazer a amizade com ${f?.name || 'este amigo'}? Vocês deixam de ver os dados um do outro.`)) return undefined;
    st = await act(() => api(`/friends/${uid}`, undefined, 'DELETE'), 'Amizade desfeita.');
    if (st && S.view === 'friend') goto('home');
    if (S.chat?.uid === uid) closeChat();
  } else {
    st = await act(() => api(`/friends/${uid}/${kind}`, {}));
  }
  if (st) applyFriends(st);
  return undefined;
}

// ------------------------------------------------------------------ página do amigo

function openFriend(uid) {
  if (S.view !== 'friend') S.backView = S.view === 'library' ? 'library' : 'home';
  S.friendUid = uid;
  S.view = 'friend';
  S.selected = null;
  S.friendTab = S.friendTab || 'activity';
  render();
  loadFriendLibrary(uid);
}

async function loadFriendLibrary(uid, force = false) {
  const cached = S.frLib[uid];
  if (cached && !force && Date.now() - cached.at < 60000) return;
  try {
    const res = await api(`/friends/${uid}/library`);
    S.frLib[uid] = { at: Date.now(), data: res.library };
  } catch (e) {
    S.frLib[uid] = { at: Date.now(), data: {}, error: e.message };
  }
  if (S.view === 'friend' && S.friendUid === uid) refreshFriendView();
}

function refreshFriendView() {
  const main = $('#main');
  const scroll = main.scrollTop;
  const focused = document.activeElement?.id;
  main.innerHTML = friendView();
  main.scrollTop = scroll;
  if (focused === 'frLibSearch') {
    const el = $('#frLibSearch');
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
}

function activityLine(a, withName) {
  const who = withName ? `<b>${esc(withName)}</b> ` : '';
  const game = `<b>${esc(a.n)}</b>`;
  const text = a.type === 'played' ? `${who}jogou ${game} por ${fmtPlaytime(a.d)}`
    : a.type === 'status' ? `${who}${{ beaten: 'zerou', completed: 'completou 100% de', playing: 'começou a jogar' }[a.st] || 'atualizou'} ${game}`
      : `${who}${game}`;
  const icon = a.type === 'played' ? '🎮' : { beaten: '🏁', completed: '🏆', playing: '▶' }[a.st] || '•';
  return `<div class="act-item">${gameThumb(a, 'small')}<div><div>${icon} ${text}</div><div class="muted">${esc(a.p || '')} · ${ago(Math.floor((a.t || 0) / 1000))}</div></div></div>`;
}

function friendView() {
  const f = friendById(S.friendUid);
  if (!f) return '<div class="page"><div class="empty"><h2>Amigo não encontrado</h2><p>A amizade pode ter sido desfeita.</p></div></div>';
  const libEntry = S.frLib[f.uid];
  const lib = Object.entries(libEntry?.data || {}).map(([id, g]) => ({ id, ...g }));
  const common = lib.filter((g) => myMatch(g));
  const finished = lib.filter((g) => g.st === 'beaten' || g.st === 'completed').length;
  const hours = lib.reduce((n, g) => n + (g.pt || 0), 0);
  const tab = S.friendTab || 'activity';
  const q = (S.frLibQuery || '').toLowerCase();
  let list = (S.frLibFilter === 'common' ? common : lib).filter((g) => !q || g.n.toLowerCase().includes(q) || (g.p || '').toLowerCase().includes(q));
  const sorters = { hours: (a, b) => (b.pt || 0) - (a.pt || 0), recent: (a, b) => (b.lp || 0) - (a.lp || 0), name: (a, b) => a.n.localeCompare(b.n, 'pt-BR') };
  list = list.sort(sorters[S.frLibSort || 'hours']);
  const libRow = (g) => {
    const mine = myMatch(g);
    return `<div class="fl-row">${gameThumb(g)}
      <div class="fl-info"><div class="fl-name">${esc(g.n)} ${g.f ? '<span class="fav">★</span>' : ''}</div>
        <div class="muted">${esc(g.p || '')}${g.y ? ` · ${g.y}` : ''}${STATUSES[g.st] ? ` · ${STATUSES[g.st].icon} ${STATUSES[g.st].label}` : ''}</div></div>
      <div class="fl-hours"><b>${g.pt ? fmtPlaytime(g.pt) : '—'}</b>${g.lp ? `<span class="muted">${ago(g.lp)}</span>` : ''}</div>
      <div class="fl-mine">${mine ? `<span class="have" title="Você também tem">✓ Você: ${mine.playtime ? fmtPlaytime(mine.playtime) : 'nunca jogou'}</span>
        <button class="btn small" data-action="play" data-id="${mine.id}">▶</button>` : ''}</div>
    </div>`;
  };
  return `<div class="page friend-page">
    <div class="fr-hero" style="--h:${hueOf(f.uid)}">
      <button class="back" data-action="back-home">‹ Voltar</button>
      ${avatarHtml(f, 'huge')}
      <div class="fr-hero-info">
        <h1>${esc(f.name)}</h1>
        <div class="fr-hero-status ${f.state}">${f.state === 'playing' && f.game ? `🎮 Jogando <b>${esc(f.game.n)}</b>${f.game.p ? ` (${esc(f.game.p)})` : ''}${f.since ? ` há ${minutesSince(f.since)}` : ''}` : friendStatus(f)}</div>
        <div class="row">
          <button class="btn primary" data-action="fr-chat" data-uid="${esc(f.uid)}">💬 Conversar</button>
          <button class="btn" data-action="fr-invite-play" data-uid="${esc(f.uid)}">🎮 Convidar para jogar</button>
          ${f.state === 'playing' && f.game && myMatch(f.game) ? `<button class="btn" data-action="play" data-id="${myMatch(f.game).id}">▶ Jogar ${esc(f.game.n)} também</button>` : ''}
          <div class="spacer"></div>
          <button class="btn ghost small" data-action="fr-remove" data-uid="${esc(f.uid)}">Desfazer amizade</button>
        </div>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Jogos</div><div class="v">${libEntry ? lib.length : '…'}</div></div>
      <div class="tile"><div class="k">Horas jogadas</div><div class="v">${libEntry ? fmtPlaytime(hours) : '…'}</div></div>
      <div class="tile"><div class="k">Zerados</div><div class="v">${libEntry ? finished : '…'}</div></div>
      <div class="tile"><div class="k">Em comum com você</div><div class="v">${libEntry ? common.length : '…'}</div></div>
    </div>
    <div class="seg">${[['activity', 'Atividade'], ['library', `Biblioteca${libEntry ? ` (${lib.length})` : ''}`]].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-action="fr-tab" data-value="${k}">${l}</button>`).join('')}</div>
    ${tab === 'activity' ? `<div class="act-list">${f.activity.length ? f.activity.map((a) => activityLine(a)).join('')
      : `<p class="muted">Nenhuma atividade recente${f.state === 'offline' ? '' : ' ainda'}. Partidas de 5 minutos ou mais e jogos zerados aparecem aqui.</p>`}</div>`
    : `<div class="toolbar fl-toolbar">
        <input class="input" id="frLibSearch" placeholder="Buscar na biblioteca de ${esc(f.name)}…" value="${esc(S.frLibQuery || '')}" autocomplete="off">
        <div class="seg">${[['all', 'Todos'], ['common', `Em comum (${common.length})`]].map(([k, l]) => `<button class="${(S.frLibFilter || 'all') === k ? 'on' : ''}" data-action="fr-lib-filter" data-value="${k}">${l}</button>`).join('')}</div>
        <label>Ordenar <select id="frLibSort">${[['hours', 'Mais jogados'], ['recent', 'Jogados por último'], ['name', 'Nome']].map(([k, l]) => `<option value="${k}" ${(S.frLibSort || 'hours') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      ${libEntry?.error ? `<p class="muted">${esc(libEntry.error)}</p>` : !libEntry ? '<p class="muted">Carregando a biblioteca…</p>'
        : !lib.length ? `<p class="muted">${esc(f.name)} não compartilha a biblioteca (ou ainda não tem jogos).</p>`
          : `<div class="fl-list">${list.map(libRow).join('') || '<p class="muted">Nenhum jogo encontrado.</p>'}</div>`}`}
  </div>`;
}

// ------------------------------------------------------------------ tela inicial

function homeFriendsHtml() {
  const fr = S.fr;
  if (!fr.configured || !(fr.friends || []).length) return '<div id="homeFriends"></div>';
  const playing = fr.friends.filter((f) => f.state === 'playing' && f.game);
  const feed = fr.friends.flatMap((f) => f.activity.map((a) => ({ ...a, who: f }))).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, 6);
  if (!playing.length && !feed.length) return '<div id="homeFriends"></div>';
  return `<div id="homeFriends">
    ${playing.length ? `<section class="home-sec"><h3>👥 Amigos jogando agora</h3><div class="memo-row">${playing.map((f) => `<div class="memo fr-memo" data-action="fr-open" data-uid="${esc(f.uid)}">
        ${avatarHtml(f)}<p><b>${esc(f.name)}</b> está jogando <b>${esc(f.game.n)}</b><br><span class="muted">${esc(f.game.p || '')}${f.since ? ` · há ${minutesSince(f.since)}` : ''}</span></p>
        ${myMatch(f.game) ? `<button class="btn small" data-action="play" data-id="${myMatch(f.game).id}" title="Você também tem">▶ Jogar</button>` : ''}
      </div>`).join('')}</div></section>` : ''}
    ${feed.length ? `<section class="home-sec"><h3>Atividade dos amigos</h3><div class="act-list compact">${feed.map((a) => `<div class="act-wrap" data-action="fr-open" data-uid="${esc(a.who.uid)}">${activityLine(a, a.who.name)}</div>`).join('')}</div></section>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ chat

function openChat(uid, { pickGame = false } = {}) {
  const f = friendById(uid);
  if (!f) return;
  if (S.chat?.uid !== uid) closeChat();
  if (!S.chat) S.chat = { uid, msgs: [], last: null, timer: null };
  document.body.classList.add('chat-open');
  let dock = $('#chatDock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'chatDock';
    document.body.appendChild(dock);
  }
  dock.innerHTML = `<div class="cd-head">${avatarHtml(f)}<div class="fp-info"><div class="fp-name">${esc(f.name)}</div><div class="fp-sub ${f.state}">${friendStatus(f)}</div></div>
      <button class="fp-x" data-chat="profile" title="Ver perfil">👤</button><button class="fp-x" data-chat="close" title="Fechar">✕</button></div>
    <div class="cd-msgs"><p class="muted cd-loading">Carregando…</p></div>
    <div class="cd-picker" hidden><input class="input" placeholder="Convidar para qual jogo?" autocomplete="off"><div class="cd-games"></div></div>
    <form class="cd-form"><button type="button" class="fp-x" data-chat="invite" title="Convidar para jogar">🎮</button>
      <input class="input" name="text" maxlength="1000" placeholder="Mensagem para ${esc(f.name)}…" autocomplete="off"><button class="btn small primary">Enviar</button></form>`;
  $('[data-chat=close]', dock).addEventListener('click', closeChat);
  $('[data-chat=profile]', dock).addEventListener('click', () => openFriend(uid));
  $('[data-chat=invite]', dock).addEventListener('click', () => toggleGamePicker());
  $('.cd-form', dock).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await sendChat(uid, { text });
  });
  const pickInput = $('.cd-picker input', dock);
  pickInput.addEventListener('input', () => drawGamePicker(pickInput.value));
  S.chat.msgs = [];
  S.chat.last = null;
  pollChat(true);
  $('.cd-form input', dock).focus();
  if (pickGame) toggleGamePicker(true);
}

function closeChat() {
  if (S.chat?.timer) clearTimeout(S.chat.timer);
  S.chat = null;
  $('#chatDock')?.remove();
  document.body.classList.remove('chat-open');
}

function toggleGamePicker(force) {
  const box = $('#chatDock .cd-picker');
  if (!box) return;
  box.hidden = force === undefined ? !box.hidden : !force;
  if (!box.hidden) {
    drawGamePicker('');
    $('input', box).value = '';
    $('input', box).focus();
  }
}

function drawGamePicker(q) {
  const box = $('#chatDock .cd-games');
  if (!box) return;
  const query = q.trim().toLowerCase();
  const list = S.games.filter((g) => !g.hidden && (!query || g.name.toLowerCase().includes(query)))
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 8);
  box.innerHTML = list.map((g) => `<button type="button" data-gid="${g.id}">${g.cover ? `<img src="${coverUrl(g)}" alt="">` : '<span class="mini"></span>'}<span>${esc(g.name)}<small>${esc(g.platform)}</small></span></button>`).join('')
    || '<p class="muted">Nenhum jogo encontrado.</p>';
  $$('[data-gid]', box).forEach((b) => b.addEventListener('click', async () => {
    const g = gameById(b.dataset.gid);
    toggleGamePicker(false);
    await sendChat(S.chat.uid, { text: '', invite: { n: g.name, p: g.platform, c: g.consoleId || emuById(g.emulatorId)?.consoleId || '' } });
  }));
}

async function sendChat(uid, body) {
  const res = await act(() => api(`/friends/${uid}/chat`, body));
  if (res) pollChat();
}

async function pollChat(first = false) {
  const chat = S.chat;
  if (!chat) return;
  clearTimeout(chat.timer);
  try {
    const res = await api(`/friends/${chat.uid}/chat${chat.last ? `?after=${encodeURIComponent(chat.last)}` : ''}`);
    if (S.chat !== chat) return;
    if (res.messages.length || first) {
      chat.msgs.push(...res.messages);
      chat.last = chat.msgs.length ? chat.msgs[chat.msgs.length - 1].id : chat.last;
      drawChat(chat);
      if (chat.last) {
        api(`/friends/${chat.uid}/read`, { id: chat.last }).catch(() => {});
        const f = friendById(chat.uid);
        if (f && f.unread) { f.unread = false; renderFriendsChrome(); }
      }
    }
  } catch { /* tenta de novo */ }
  if (S.chat === chat) chat.timer = setTimeout(pollChat, document.hidden ? 15000 : 3000);
}

function drawChat(chat) {
  const box = $('#chatDock .cd-msgs');
  if (!box) return;
  const me = S.fr.me?.uid;
  const f = friendById(chat.uid);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let lastDay = '';
  box.innerHTML = chat.msgs.map((msg) => {
    const mine = msg.from === me;
    const d = new Date(msg.t || Date.now());
    const day = d.toLocaleDateString('pt-BR');
    const sep = day !== lastDay ? `<div class="cd-day">${day === new Date().toLocaleDateString('pt-BR') ? 'Hoje' : day}</div>` : '';
    lastDay = day;
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    let inv = '';
    if (msg.inv) {
      const match = myMatch(msg.inv);
      inv = `<div class="cd-invite">${gameThumb(msg.inv, 'small')}<div><div>🎮 ${mine ? 'Você convidou para jogar' : `${esc(f?.name || '')} convidou você para jogar`}</div>
        <b>${esc(msg.inv.n)}</b><div class="muted">${esc(msg.inv.p || '')}</div>
        ${mine ? '' : match ? `<button class="btn small primary" data-action="play" data-id="${match.id}">▶ Jogar agora</button>` : '<div class="muted">Você não tem esse jogo na biblioteca.</div>'}</div></div>`;
    }
    return `${sep}<div class="cd-msg ${mine ? 'mine' : ''}">${inv}${msg.text ? `<div class="cd-text">${esc(msg.text)}</div>` : ''}<span class="cd-time">${time}</span></div>`;
  }).join('') || `<p class="muted cd-loading">Nenhuma mensagem ainda. Diga oi para ${esc(f?.name || 'seu amigo')}! 👋</p>`;
  if (nearBottom || chat.msgs.length <= 80) box.scrollTop = box.scrollHeight;
}

// Convidar um amigo para o jogo aberto na página do jogo.
function inviteFriendModal(gameId) {
  const g = gameById(gameId);
  const list = (S.fr.friends || []);
  if (!list.length) return toast('Adicione amigos primeiro (botão 👥 no topo).', true);
  const m = openModal(`<h2>Convidar para jogar ${esc(g.name)}</h2>
    <div class="fr-pick">${list.map((f) => `<button data-uid="${esc(f.uid)}">${avatarHtml(f)}<span><b>${esc(f.name)}</b><small>${friendStatus(f)}</small></span></button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" data-close>Cancelar</button></div>`);
  $$('[data-uid]', m).forEach((b) => b.addEventListener('click', async () => {
    const res = await act(() => api(`/friends/${b.dataset.uid}/chat`, { text: '', invite: { n: g.name, p: g.platform, c: g.consoleId || emuById(g.emulatorId)?.consoleId || '' } }), 'Convite enviado!');
    if (res) closeModal();
  }));
  return undefined;
}

// ------------------------------------------------------------------ configurações

function friendsSettingsHtml() {
  const fr = S.fr;
  if (!fr.configured) {
    return `<div class="section"><h3>Amigos</h3>
      <p>Veja quem está online e jogando, a atividade e a biblioteca dos seus amigos, e converse com eles.</p>
      <div class="row"><button class="btn primary" data-action="fr-setup" data-tab="${fr.defaultServer ? 'default' : 'invite'}">Ativar amigos</button></div></div>`;
  }
  const me = fr.me;
  const toggle = (key, title, desc) => `<div class="opt"><div><div class="t">${title}</div><div class="d">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-fr-flag="${key}" ${me[key] ? 'checked' : ''}><span></span></label></div>`;
  const local = (key, title) => `<div class="opt"><div><div class="t">${title}</div></div>
    <label class="switch"><input type="checkbox" data-fr-pref="${key}" ${frPrefs()[key] !== false ? 'checked' : ''}><span></span></label></div>`;
  return `<div class="section"><h3>Amigos</h3>
    <div class="inline" style="max-width:520px">
      <input class="input" id="frName" maxlength="40" value="${esc(me.name)}" placeholder="Seu nome para os amigos">
      <button class="btn" data-action="fr-save-name">Salvar nome</button>
    </div>
    <p style="margin-top:12px">Seu código de amigo: <b>${esc(me.code)}</b>
      <button class="btn small" data-action="fr-copy-code">Copiar código</button> <button class="btn small" data-action="fr-invite">Copiar convite</button></p>
    <h4 class="sub-h">Privacidade — o que seus amigos veem</h4>
    <div class="opts">
      ${toggle('shareGame', 'O que estou jogando', 'Mostra o jogo aberto e há quanto tempo. Desligado, você aparece só como online.')}
      ${toggle('shareActivity', 'Minha atividade', 'Partidas de 5 minutos ou mais e jogos que você começou, zerou ou completou.')}
      ${toggle('shareLibrary', 'Minha biblioteca', 'Nomes dos jogos, horas e status (jogos ocultos nunca aparecem).')}
    </div>
    <h4 class="sub-h">Avisos</h4>
    <div class="opts">${local('notifyOnline', 'Quando um amigo fica online')}${local('notifyPlaying', 'Quando um amigo começa a jogar')}</div>
    <div class="row" style="margin-top:14px"><button class="btn danger" data-action="fr-leave">Sair dos amigos e apagar meus dados do servidor</button></div>
  </div>`;
}

async function leaveFriends() {
  if (!confirm('Sair dos amigos? Seu perfil, atividade, biblioteca e amizades são apagados do servidor. Sua biblioteca na SannStation continua igual.')) return;
  const st = await act(() => api('/friends/leave', {}), 'Você saiu dos amigos. Seus dados foram apagados do servidor.');
  if (st) { applyFriends(st); closeChat(); if (S.view === 'friend') goto('home'); else render(); }
}

// ------------------------------------------------------------------ eventos

document.addEventListener('click', (e) => {
  // Só a ação mais próxima do clique conta: um botão ▶ dentro de um card de amigo é do botão, não do card.
  const t = e.target.closest('[data-action]');
  if (!t || !(t.dataset.action.startsWith('fr-') || ['back-home', 'invite-friend'].includes(t.dataset.action))) return;
  e.stopPropagation();
  const uid = t.dataset.uid;
  switch (t.dataset.action) {
    case 'fr-panel': return toggleFriendsPanel();
    case 'fr-refresh': return loadFriends({ sync: true });
    case 'fr-setup': return friendsSetupModal(t.dataset.tab);
    case 'fr-add': return friendsAction('add');
    case 'fr-accept': return friendsAction('accept', uid);
    case 'fr-decline': return friendsAction('decline', uid);
    case 'fr-cancel': return friendsAction('cancel', uid);
    case 'fr-remove': return friendsAction('remove', uid);
    case 'fr-open': return openFriend(uid);
    case 'fr-chat': return openChat(uid);
    case 'fr-invite-play': return openChat(uid, { pickGame: true });
    case 'fr-avatar': return avatarPicker();
    case 'fr-copy-code': return copyText(S.fr.me.code, `Código ${S.fr.me.code} copiado.`);
    case 'fr-invite': return api('/friends/invite').then((r) => copyText(r.invite, 'Convite copiado! Mande para seu amigo (WhatsApp, Discord…). Ele cola em Amigos → Recebi um convite.'));
    case 'fr-tab': S.friendTab = t.dataset.value; return refreshFriendView();
    case 'fr-lib-filter': S.frLibFilter = t.dataset.value; return refreshFriendView();
    case 'fr-save-name': {
      const name = $('#frName').value.trim();
      return act(() => api('/friends/profile', { name }, 'PUT'), 'Nome atualizado.').then((st) => st && applyFriends(st));
    }
    case 'fr-leave': return leaveFriends();
    case 'back-home': return goto(S.backView === 'library' ? 'library' : 'home');
    case 'invite-friend': return inviteFriendModal(t.dataset.id);
    default: return undefined;
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'frAddInput') friendsAction('add');
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'frLibSearch') { S.frLibQuery = e.target.value; refreshFriendView(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'frLibSort') { S.frLibSort = e.target.value; refreshFriendView(); }
  if (e.target.dataset.frFlag) {
    act(() => api('/friends/profile', { [e.target.dataset.frFlag]: e.target.checked }, 'PUT')).then((st) => st && applyFriends(st));
  }
  if (e.target.dataset.frPref) saveFrPrefs({ [e.target.dataset.frPref]: e.target.checked });
});
$('#friendsBtn').addEventListener('click', () => toggleFriendsPanel());

// Amigos atualizam sozinhos (o app sincroniza com o servidor; aqui só lemos o estado local).
setInterval(() => { if (S.fr.configured && !document.hidden) loadFriends(); }, 10000);
loadFriends().then(() => { if (frPrefs().panel) toggleFriendsPanel(true); });
