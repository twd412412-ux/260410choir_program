'use strict';
const dialog = document.getElementById('previewDialog');
const dialogContent = document.getElementById('dialogContent');
let lastFocus;
let snapshot;
const note = '<p class="preview-dialog-note">디자인 확인용 샘플입니다. 실제 계정·악보·자리배치 데이터는 조회하거나 변경하지 않습니다.</p>';
function icons() { if (window.lucide) lucide.createIcons(); }
function decorate() {
  const map = { notificationBellBtn: 'bell', profileButton: 'user-round', btnDark: 'moon', btnLock: 'lock-keyhole' };
  for (const [id, name] of Object.entries(map)) {
    const target = document.getElementById(id);
    if (target && !target.querySelector('.icon-original')) target.innerHTML = `<span class="icon-original">${target.innerHTML}</span><span class="icon-refined"><i data-lucide="${name}"></i></span>`;
  }
  const navIcons = { songs: 'music-2', favorites: 'star', archive: 'images', home: 'house', calendar: 'calendar-days', scores: 'file-music', admin: 'settings-2' };
  document.querySelectorAll('[data-t]').forEach(target => {
    const icon = target.querySelector('.nav-icon,.home-fab-icon');
    if (icon && !icon.querySelector('.icon-original')) icon.innerHTML = `<span class="icon-original">${icon.innerHTML}</span><span class="icon-refined"><i data-lucide="${navIcons[target.dataset.t]}"></i></span>`;
  });
  document.querySelectorAll('.home-card-icon').forEach(target => {
    if (!target.querySelector('.icon-original')) target.innerHTML = `<span class="icon-original">${target.innerHTML}</span><span class="icon-refined"><i data-lucide="${target.closest('.home-seating-card') ? 'armchair' : 'calendar-days'}"></i></span>`;
  });
  const eventIcon = document.querySelector('.home-event-eyebrow [aria-hidden]');
  if (eventIcon && !eventIcon.querySelector('.icon-original')) eventIcon.innerHTML = `<span class="icon-original">${eventIcon.innerHTML}</span><span class="icon-refined"><i data-lucide="music-2"></i></span>`;
  icons();
}
function showDialog(title, content) {
  lastFocus = document.activeElement;
  document.getElementById('dialogTitle').textContent = title;
  dialogContent.innerHTML = content;
  if (!dialog.open) dialog.showModal();
  icons();
}
function safe(text) { const el = document.createElement('span'); el.textContent = text; return el.innerHTML; }
function showSearch() {
  showDialog('통합검색', '<input class="demo-search" type="search" aria-label="곡·악보·일정·사진 검색" placeholder="곡·악보·일정·사진 검색"><div id="demoResults" aria-live="polite"></div>' + note);
  const input = dialog.querySelector('input');
  input.addEventListener('input', () => renderResults(input.value));
  renderResults('');
  input.focus();
}
function initials(value) { return [...value].map(char => { const code = char.charCodeAt(0) - 0xac00; return code >= 0 && code <= 11171 ? 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'[Math.floor(code / 588)] : char; }).join(''); }
function renderResults(query) {
  const compact = text => text.toLowerCase().replace(/\s/g, '');
  const rows = snapshot.titles.filter(title => compact(title).includes(compact(query)) || initials(compact(title)).includes(compact(query)));
  document.getElementById('demoResults').innerHTML = rows.length ? rows.map((title, index) => `<button class="demo-result" data-sample-title="${safe(title)}">${safe(title)}<small>곡 · 싱어 악보</small></button>`).join('') : '<div class="demo-results-empty">검색 결과가 없습니다</div>';
}
function setEventTab(tab) {
  const card = document.getElementById('homeEventHub');
  card.querySelectorAll('.home-event-tab').forEach(button => { const selected = button.dataset.previewArg === tab; button.classList.toggle('on', selected); button.setAttribute('aria-selected', String(selected)); });
  card.querySelector('.home-event-panel')?.remove();
  card.querySelector('.preview-event-info')?.remove();
  if (tab === 'program') card.insertAdjacentHTML('beforeend', snapshot.eventProgram);
  else card.insertAdjacentHTML('beforeend', `<div class="preview-event-info home-event-panel">${snapshot.eventInfo}</div>`);
}
function act(action, arg, target) {
  if (action === 'openGlobalSearch') return showSearch();
  if (action === 'toggleDark') { document.documentElement.classList.toggle('dark'); return; }
  if (action === 'setHomeEventHubTab') return setEventTab(arg);
  if (action === 'openPublicSeatingModal') {
    const title = target.querySelector('.home-seating-plan-title').textContent;
    return showDialog(title, '<div class="demo-seat-grid">' + Array.from({ length: 24 }, (_, i) => `<span>${i + 1}</span>`).join('') + '</div><p style="text-align:center">센터 · 지휘</p>' + note);
  }
  if (action === 'openDetail' || action === 'openScorePickerForSong') {
    const title = snapshot.titles[Number(arg.replace(/demo-song-/, ''))] || target.closest('.home-song-line')?.querySelector('.home-song-title')?.textContent || '악보';
    return showDialog(title, '<p>주일찬송</p><button class="demo-result" data-preview-action="sampleScore">싱어 악보 <small>v1 · 2026.09.25</small></button>' + note);
  }
  if (/Score/.test(action)) return showDialog('악보', '<p>싱어 악보 · v1 · 2026.09.25</p>' + note);
  if (action === 'openFeatureUpdateGuide') return showDialog('이번 업데이트에서 달라진 점', '<div class="demo-result">통합검색</div><div class="demo-result">악보 버전 확인</div><div class="demo-result">자리배치</div>' + note);
  if (action === 'switchTab' && arg === 'home') { scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const title = { openAppNotificationCenter: '새 소식', openUserModal: '프로필', openAdminLogin: '관리', openSchDetail: '일정', openHomeGuide: '처음 사용하는 방법', reloadAppVersion: '앱 업데이트' }[action] || { songs: '곡목록', favorites: '즐찾', archive: '사진첩', calendar: '일정', scores: '악보' }[arg] || '샘플 악보';
  showDialog(title, '<p>홈 화면 디자인 비교용입니다.</p>' + note);
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  document.body.classList.toggle('refined', button.dataset.mode === 'refined');
  document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));
document.addEventListener('click', event => {
  const title = event.target.closest('[data-sample-title]');
  if (title) { showDialog(title.dataset.sampleTitle, '<p>싱어 악보 · v1 · 2026.09.25</p>' + note); return; }
  const target = event.target.closest('[data-preview-action]');
  if (target && snapshot) { event.stopPropagation(); act(target.dataset.previewAction, target.dataset.previewArg || '', target); }
});
document.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role=button]')) { event.preventDefault(); event.target.click(); }
});
dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => lastFocus?.focus());
dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
fetch('snapshot.json').then(response => { if (!response.ok) throw new Error('snapshot'); return response.json(); }).then(data => { snapshot = data; decorate(); }).catch(() => showDialog('불러오지 못했습니다', '<p>화면을 새로고침해 주세요.</p>'));
