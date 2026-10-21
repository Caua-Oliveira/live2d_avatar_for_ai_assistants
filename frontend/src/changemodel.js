import './style.css';
import './responsive.css';
import './changemodel.css';
import { renderIcons } from './icons.js';
import { Avatar } from './avatar.js';
import { loadAppearance, normalizeAppearance, saveAppearance } from './avatar-appearance.js';

document.title = 'Personalizar avatar — Jorgina';
document.body.classList.add('model-editor');
document.body.innerHTML = `
  <a class="skip-link" href="#appearance-search">Ir para os controles</a>
  <div class="app-shell">
    <header class="site-header">
      <a class="brand" href="/" aria-label="Jorgina, início">
        <span class="brand-mark" aria-hidden="true"><i data-icon="sparkles"></i></span>
        <span>jorgina<span class="brand-dot">.</span></span>
      </a>
      <a class="appearance-link editor-back" href="/">← Voltar à conversa</a>
    </header>
    <main class="editor-main">
      <div class="editor-heading">
        <div><p class="eyebrow">MO.v2.7 · ESTÚDIO DO AVATAR</p><h1>Uma Jorgina <span>do seu jeito.</span></h1></div>
        <p>Experimente cabelo, roupas e acessórios.<br>Veja cada mudança antes de salvar.</p>
      </div>
      <div class="editor-workspace">
        <section class="editor-preview" aria-label="Prévia do avatar">
          <div class="avatar-stage" id="editor-stage">
            <div class="avatar-halo" aria-hidden="true"><div></div></div>
            <div id="avatar-canvas" role="img" aria-label="Prévia animada da aparência de Jorgina"></div>
            <div id="avatar-loading" class="avatar-loading"><span class="loader"></span><span>Carregando MO.v2.7…</span></div>
            <div id="avatar-error" class="avatar-error" hidden><p>Não foi possível carregar o avatar.</p><button id="retry-avatar" class="text-button">Tentar novamente</button></div>
            <span class="editor-preview-badge">PRÉVIA AO VIVO</span>
          </div>
          <div class="editor-preview-tools">
            <label for="framing-select">Enquadramento
              <select id="framing-select"><option value="full">Corpo inteiro</option><option value="portrait">Como na conversa</option></select>
            </label>
          </div>
          <p class="editor-note">O visual salvo será o padrão para todos os navegadores e dispositivos conectados a este servidor. As animações e o contato visual continuam funcionando.</p>
        </section>
        <section class="editor-panel" aria-labelledby="appearance-title">
          <div class="editor-panel-header">
            <h2 id="appearance-title">Personalizar aparência</h2>
            <label class="sr-only" for="appearance-search">Buscar controle de aparência</label>
            <input id="appearance-search" type="search" placeholder="Buscar cabelo, roupa, óculos…" disabled>
            <p>Estilos numerados seguem as opções do modelo. Alguns detalhes só aparecem com o item correspondente ativo.</p>
          </div>
          <div id="appearance-controls" class="appearance-controls" aria-busy="true"></div>
          <p id="no-controls" class="editor-empty" hidden>Nenhum controle encontrado.</p>
          <footer class="editor-save-bar">
            <p id="save-status" role="status" aria-live="polite">Carregando controles…</p>
            <div class="editor-actions">
              <button id="reset-appearance" class="editor-secondary" disabled>Restaurar original</button>
              <button id="discard-appearance" class="editor-secondary" disabled>Descartar</button>
              <button id="save-appearance" class="editor-primary" disabled>Salvar como padrão</button>
            </div>
          </footer>
        </section>
      </div>
    </main>
  </div>`;
renderIcons();

const $ = selector => document.querySelector(selector);
const avatar = new Avatar($('#avatar-canvas'), { framing: 'full' });
let saved = {};
let dirty = false;
let saving = false;
const inputs = new Map();

function updateDirty(message) {
  dirty = JSON.stringify(saved) !== JSON.stringify(avatar.appearance);
  $('#save-appearance').disabled = saving || !dirty;
  $('#discard-appearance').disabled = saving || !dirty;
  $('#reset-appearance').disabled = saving;
  $('#save-status').textContent = message || (dirty ? 'Alterações na prévia — ainda não salvas.' : 'Visual padrão global atual.');
  $('#save-status').dataset.kind = '';
}

function refreshInputs() {
  for (const [id, { input, output }] of inputs) {
    input.value = avatar.appearance[id];
    if (output) output.value = Number(input.value).toFixed(2);
  }
}

function renderControls() {
  inputs.clear();
  const container = $('#appearance-controls');
  container.replaceChildren();
  const sections = new Map();
  for (const control of avatar.appearanceControls) {
    let section = sections.get(control.group);
    if (!section) {
      section = document.createElement('details');
      section.className = 'appearance-group';
      section.open = control.group === 'hair' || control.group === 'clothes';
      const summary = document.createElement('summary');
      summary.textContent = control.groupLabel;
      section.append(summary);
      sections.set(control.group, section);
      container.append(section);
    }
    const row = document.createElement('div');
    row.className = 'appearance-control';
    row.dataset.search = `${control.label} ${control.groupLabel}`.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const label = document.createElement('label');
    label.htmlFor = `appearance-${control.id}`;
    label.textContent = control.label;
    const input = document.createElement(control.type === 'choice' ? 'select' : 'input');
    input.id = label.htmlFor;
    let output;
    if (control.type === 'choice') {
      for (let value = control.min; value <= control.max; value++) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === control.default ? `${value} · Original` : `Estilo ${value}`;
        input.append(option);
      }
    } else {
      input.type = 'range';
      input.min = control.min;
      input.max = control.max;
      input.step = control.step;
      output = document.createElement('output');
      output.htmlFor = input.id;
      row.append(output);
    }
    input.addEventListener('input', () => {
      avatar.setAppearance({ ...avatar.appearance, [control.id]: Number(input.value) });
      if (output) output.value = Number(input.value).toFixed(2);
      updateDirty();
    });
    inputs.set(control.id, { input, output });
    row.prepend(label);
    row.append(input);
    section.append(row);
  }
  refreshInputs();
  container.setAttribute('aria-busy', 'false');
}

$('#appearance-search').addEventListener('input', event => {
  const query = event.target.value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  let count = 0;
  for (const section of document.querySelectorAll('.appearance-group')) {
    let matches = 0;
    for (const row of section.querySelectorAll('.appearance-control')) {
      row.hidden = !row.dataset.search.includes(query);
      if (!row.hidden) matches++;
    }
    section.hidden = matches === 0;
    if (query && matches) section.open = true;
    count += matches;
  }
  $('#no-controls').hidden = count > 0;
});

$('#framing-select').addEventListener('change', event => {
  avatar.framing = event.target.value;
  avatar.resize();
});
$('#reset-appearance').addEventListener('click', () => {
  avatar.setAppearance(normalizeAppearance({}, avatar.appearanceControls));
  refreshInputs();
  updateDirty('Visual original na prévia. Salve para torná-lo padrão.');
});
$('#discard-appearance').addEventListener('click', () => {
  avatar.setAppearance(saved);
  refreshInputs();
  updateDirty('Alterações descartadas. Visual salvo restaurado.');
});
$('#save-appearance').addEventListener('click', async () => {
  if (saving || !dirty) return;
  saving = true;
  updateDirty('Salvando padrão no servidor…');
  let message, failed = false;
  try {
    saved = await saveAppearance(avatar.appearance, avatar.appearanceControls);
    message = JSON.stringify(saved) === JSON.stringify(avatar.appearance)
      ? 'Padrão global salvo! Todos os dispositivos usarão este visual.'
      : 'Padrão global salvo. Há novas alterações na prévia ainda não salvas.';
  } catch {
    message = 'Não foi possível salvar no servidor. Suas alterações continuam na prévia; tente novamente.';
    failed = true;
  } finally {
    saving = false;
    updateDirty(message);
    if (failed) $('#save-status').dataset.kind = 'error';
  }
});

async function loadAvatar() {
  $('#avatar-loading').hidden = false;
  $('#avatar-error').hidden = true;
  try {
    await avatar.load();
    saved = await loadAppearance(avatar.appearanceControls);
    avatar.setAppearance(saved);
    renderControls();
    $('#appearance-search').disabled = false;
    $('#reset-appearance').disabled = false;
    updateDirty();
  } catch (error) {
    console.error('Live2D editor:', error);
    $('#avatar-error').hidden = false;
    $('#save-status').textContent = 'Não foi possível carregar o avatar ou o padrão do servidor. Verifique a conexão e tente novamente.';
  } finally {
    $('#avatar-loading').hidden = true;
  }
}
$('#retry-avatar').addEventListener('click', loadAvatar);
window.addEventListener('beforeunload', event => {
  if (dirty || saving) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => avatar.destroy());
void loadAvatar();
