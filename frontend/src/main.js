import './style.css';
import './responsive.css';
import { icon, renderIcons } from './icons.js';
import { Avatar } from './avatar.js';
import { FaceTracking } from './camera.js';
import { LivePlayer, LiveSession } from './live.js';
import { LiveConversation } from './live-conversation.js';
import { loadAppearance } from './avatar-appearance.js';

renderIcons();
const $ = selector => document.querySelector(selector);
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const history = $('#chat-history');
const input = $('#chat-input');
// Pausa o microfone imediatamente ao ocultar a aba, mas aguarda 1 minuto antes de
// fechar o WebSocket para preservar o contexto em trocas breves de aba.
const HIDDEN_DISCONNECT_MS = 60000;

// Mantém o avatar e o campo de texto visíveis quando o teclado virtual abre no celular.
function updateViewportHeight() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
window.visualViewport?.addEventListener('resize', updateViewportHeight);
window.addEventListener('resize', updateViewportHeight);
updateViewportHeight();

const avatar = new Avatar($('#avatar-canvas'));
let appearanceGeneration = 0;
async function refreshAppearance() {
  if (!avatar.model || document.hidden) return;
  const generation = ++appearanceGeneration;
  const parameters = await loadAppearance(avatar.appearanceControls);
  if (generation === appearanceGeneration) avatar.setAppearance(parameters);
}
window.addEventListener('focus', () => { void refreshAppearance().catch(() => {}); });

let state = 'idle';
let recording = false;
let micStarting = false;
let micGeneration = 0;
let cameraEnabled = false;
let voiceEnabled = true;
let toastTimer;
let hiddenTimer = null;
let liveEnabled = false;
let liveAvailable = false;
let liveStarting = false;
let pendingText = null;
let pendingMic = false;
let pendingBubble = null;

const stateLabels = {
  idle: 'Pronta para ajudar',
  listening: 'Estou ouvindo você',
  thinking: 'Pensando na sua pergunta…',
  speaking: 'Uma resposta para você',
};

const readyPromptStatus = 'Clique em iniciar, use o microfone ou envie uma mensagem.';
const unavailableStatus = 'Live indisponível: configure o provedor e a chave no servidor.';

function setState(next, animation = null, playback = {}) {
  state = next;
  const tracks = avatar.setState(next, animation, playback);
  $('#avatar-stage').dataset.animationTracks = String(tracks);
  if (animation && !tracks) {
    console.warn('Reply has no usable avatar animation tracks.');
    toast('A animação desta resposta não ficou disponível. Tente pedir novamente.', 'error');
  }
  $('#avatar-stage').dataset.state = next;
  $('#avatar-state-label').textContent = stateLabels[next];
}

function toast(message, kind = 'info') {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').dataset.kind = kind;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

function setPendingBubble(visible, text = 'Preparando voz e expressão…') {
  if (!visible) {
    pendingBubble?.remove();
    pendingBubble = null;
    return;
  }
  if (!pendingBubble) {
    pendingBubble = document.createElement('article');
    pendingBubble.className = 'message assistant';
    pendingBubble.setAttribute('aria-label', 'Preparando resposta');
    const body = document.createElement('div');
    body.className = 'message-body thinking-bubble';
    body.innerHTML = '<span></span><span></span><span></span>';
    const label = document.createElement('small');
    body.append(label);
    pendingBubble.append(body);
  }
  pendingBubble.querySelector('small').textContent = text;
  history.append(pendingBubble);
  scrollToLatest();
}

function updateControls() {
  const connectingLive = liveEnabled && !live.ready;
  const blocked = !liveAvailable || liveStarting || connectingLive;
  $('#live-toggle').disabled = !liveAvailable || liveStarting;
  $('#send-btn').disabled = blocked || !input.value.trim();
  input.disabled = blocked;
  $('#mic-btn').disabled = blocked || micStarting;
  $('#mic-btn').setAttribute('aria-pressed', String(recording));
  $('#mic-btn').setAttribute('aria-label', recording ? 'Pausar microfone Live' : micStarting ? 'Abrindo microfone Live' : 'Ativar microfone Live');
  $('#mic-btn').innerHTML = `${icon(recording ? 'stop' : 'mic')}<span>${recording ? 'Pausar microfone' : micStarting ? 'Abrindo…' : 'Microfone Live'}</span>`;
}

function scrollToLatest() {
  history.scrollTo({ top: history.scrollHeight, behavior: avatar.reducedMotion.matches ? 'instant' : 'smooth' });
}

function appendMessage(role, text, options = {}) {
  if (role !== 'user') setPendingBubble(false);
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.innerHTML = `${role === 'assistant' ? icon('sparkles') : ''}<strong>${role === 'user' ? 'Você' : role === 'error' ? 'Vamos tentar de novo?' : 'Jorgina'}</strong>`;
  const time = document.createElement('time');
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  meta.append(time);
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = text;
  article.append(meta, body);
  if (role === 'assistant' && !options.welcome) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const copy = document.createElement('button');
    copy.className = 'message-action';
    copy.innerHTML = `${icon('copy')} Copiar`;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(body.textContent); toast('Resposta copiada.'); }
      catch { toast('Não foi possível copiar. Você pode selecionar o texto da resposta.', 'error'); }
    });
    actions.append(copy);
    article.append(actions);
  }
  history.append(article);
  if (pendingBubble && role === 'user') history.append(pendingBubble);
  scrollToLatest();
  return article;
}

function welcome() {
  setPendingBubble(false);
  history.replaceChildren();
  appendMessage('assistant', 'Como posso ajudar?', { welcome: true });
}

function dispatchLiveText(text) {
  try { liveConversation.sendText(text, event => live.send(event)); }
  catch (error) { live.fail(error.message); return; }
  input.value = '';
  input.style.height = '';
  updateControls();
}

function sendText(text = input.value.trim()) {
  text = text.trim();
  if (!text || !liveAvailable || liveStarting) return;
  if (!liveEnabled) {
    void startLive({ text });
    return;
  }
  if (!live.ready) return;
  dispatchLiveText(text);
}

$('#chat-form').addEventListener('submit', event => { event.preventDefault(); sendText(); });
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  updateControls();
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendText(); }
});

function recordingUIOff() {
  recording = false;
  micStarting = false;
  $('#recording-panel').hidden = true;
  updateControls();
}

$('#mic-btn').addEventListener('click', () => {
  if (!liveAvailable || liveStarting || micStarting) return;
  if (!liveEnabled) {
    void startLive({ mic: true });
    return;
  }
  void toggleLiveMic();
});
$('#cancel-recording').addEventListener('click', () => {
  if (liveEnabled && recording && !micStarting) void toggleLiveMic();
});

function deviceError(error, device) {
  if (error.name === 'NotAllowedError') return `Permita o acesso ao ${device === 'câmera' ? 'vídeo' : device} nas configurações do navegador e tente novamente.`;
  if (error.name === 'NotFoundError') return `Nenhum dispositivo de ${device} encontrado. Conecte um e tente novamente.`;
  if (error.name === 'NotReadableError') return `Não consegui abrir ${device === 'câmera' ? 'a câmera' : 'o microfone'}. Talvez outro aplicativo esteja usando o dispositivo.`;
  return `Não foi possível ativar ${device === 'câmera' ? 'a câmera' : 'o microfone'}. ${error.message || 'Tente novamente.'}`;
}

function cameraUI(enabled) {
  cameraEnabled = enabled;
  $('#camera-btn').setAttribute('aria-pressed', String(enabled));
  $('#camera-btn').querySelector('span').textContent = enabled ? 'Contato visual ativado' : 'Ativar contato visual';
  $('#camera-feedback').hidden = !enabled;
}

const camera = new FaceTracking($('#camera-video'), (...gaze) => avatar.setGaze(...gaze), status => {
  $('#camera-status').textContent = status;
}, error => { cameraUI(false); toast(deviceError(error, 'câmera'), 'error'); });

$('#camera-btn').addEventListener('click', async () => {
  if (cameraEnabled) { camera.stop(); cameraUI(false); return; }
  cameraUI(true);
  $('#camera-status').textContent = 'Aguardando acesso à câmera…';
  try { await camera.start(); }
  catch (error) { cameraUI(false); toast(deviceError(error, 'câmera'), 'error'); }
});

$('#sound-btn').addEventListener('click', () => {
  voiceEnabled = !voiceEnabled;
  $('#sound-btn').setAttribute('aria-pressed', String(voiceEnabled));
  $('#sound-btn').innerHTML = `${icon(voiceEnabled ? 'volume' : 'muted')}<span>${voiceEnabled ? 'Voz ativada' : 'Voz desativada'}</span><span class="toggle-track" aria-hidden="true"></span>`;
  livePlayer.setMuted(!voiceEnabled);
});

$('#stop-audio').addEventListener('click', () => {
  if (liveEnabled) livePlayer.interrupt(livePlayer.turn?.id);
});

const liveConversation = new LiveConversation({
  append: (role, text) => appendMessage(role, text),
  update(article, text) { article.querySelector('.message-body').textContent = text; scrollToLatest(); },
  remove(article) { article.remove(); },
  onStatus(message) { $('#live-status').textContent = message; },
  onWaiting(waiting, message) {
    if (!liveEnabled) {
      setPendingBubble(false);
      return;
    }
    setPendingBubble(waiting, message || 'Preparando voz e expressão…');
    if (state === 'speaking') return;
    if (waiting) setState('thinking');
    else if (state === 'thinking') setState(recording ? 'listening' : 'idle');
  },
});

const livePlayer = new LivePlayer({
  onSpeech(speaking, animation, audio, timing = {}) {
    if (!liveEnabled) return;
    $('#stop-audio').hidden = !speaking;
    setState(speaking ? 'speaking' : recording ? 'listening' : 'idle', speaking ? animation : null, { ...timing, audio });
  },
  onLevel(level) { if (liveEnabled) avatar.mouth = level; },
});

const live = new LiveSession(API_BASE, {
  onEvent(event) {
    if (!liveEnabled) return;
    switch (event.type) {
      case 'ready': {
        $('#live-status').textContent = 'Live conectado. Ative o microfone ou envie texto.';
        const queuedText = pendingText;
        const queuedMic = pendingMic;
        pendingText = null;
        pendingMic = false;
        updateControls();
        if (queuedText) dispatchLiveText(queuedText);
        else if (queuedMic) void toggleLiveMic();
        break;
      }
      case 'audio':
        liveConversation.audio(event.turn_id);
        try { livePlayer.enqueue(event); }
        catch (error) {
          const message = `Áudio Live indisponível: ${error.message} Reconecte o Live para receber voz e expressão.`;
          liveConversation.warning({ turn_id: event.turn_id, message });
          stopLive();
          $('#live-status').textContent = message;
          toast(message, 'error');
        }
        break;
      case 'animation': livePlayer.animation(event); break;
      case 'transcript': liveConversation.transcript(event); break;
      case 'waiting': liveConversation.waiting(event); break;
      case 'warning':
        livePlayer.interrupt(event.turn_id);
        liveConversation.warning(event);
        break;
      case 'interrupted':
        livePlayer.interrupt(event.turn_id);
        liveConversation.complete(event.turn_id, true);
        break;
      case 'turn_complete':
        livePlayer.complete(event.turn_id);
        liveConversation.complete(event.turn_id);
        break;
    }
  },
  onMicEnded() { recordingUIOff(); toast('Microfone Live desconectado.', 'error'); },
  onError(message) { stopLive(); liveConversation.error(message); toast(message, 'error'); },
});

function clearHiddenTimer() {
  clearTimeout(hiddenTimer);
  hiddenTimer = null;
}

function stopLive() {
  clearHiddenTimer();
  micGeneration++;
  liveStarting = false;
  pendingText = null;
  pendingMic = false;
  live.disconnect();
  livePlayer.destroy();
  livePlayer.context = null;
  liveEnabled = false;
  liveConversation.reset();
  setPendingBubble(false);
  recordingUIOff();
  avatar.mouth = 0;
  setState('idle');
  $('#stop-audio').hidden = true;
  $('#live-toggle').setAttribute('aria-pressed', 'false');
  $('#live-toggle').textContent = 'Iniciar conversa Live';
  $('#live-status').textContent = liveAvailable ? readyPromptStatus : unavailableStatus;
  updateControls();
}

async function startLive({ text = null, mic = false } = {}) {
  if (liveEnabled || liveStarting || !liveAvailable) return false;
  clearHiddenTimer();
  liveStarting = true;
  pendingText = text;
  pendingMic = mic;
  updateControls();
  try {
    await livePlayer.unlock();
    if (!liveStarting) return false;
    livePlayer.setMuted(!voiceEnabled);
    liveEnabled = true;
    liveStarting = false;
    $('#live-toggle').textContent = 'Encerrar conversa Live';
    $('#live-toggle').setAttribute('aria-pressed', 'true');
    $('#live-status').textContent = 'Conectando ao Live…';
    live.connect();
    updateControls();
    return true;
  } catch (error) {
    stopLive();
    liveConversation.error(error.message);
    toast(error.message, 'error');
    return false;
  }
}

async function pauseLiveMic() {
  if (!recording && !micStarting) return;
  const generation = ++micGeneration;
  recording = false;
  micStarting = true;
  $('#recording-panel').hidden = true;
  updateControls();
  await live.stopMic();
  if (generation !== micGeneration) return;
  recordingUIOff();
  if (state !== 'speaking') setState('idle');
}

async function toggleLiveMic() {
  if (!live.ready || micStarting) return;
  if (recording) {
    await pauseLiveMic();
    return;
  }
  const generation = ++micGeneration;
  micStarting = true;
  updateControls();
  try {
    const started = await live.startMic();
    if (!started || generation !== micGeneration || !liveEnabled) return;
    micStarting = false;
    recording = true;
    if (state !== 'speaking') setState('listening');
    $('#recording-panel').hidden = false;
    $('#recording-time').textContent = 'Live';
    updateControls();
  } catch (error) {
    if (generation !== micGeneration) return;
    live.stopMic();
    recordingUIOff();
    toast(deviceError(error, 'microfone'), 'error');
  }
}

$('#live-toggle').addEventListener('click', () => {
  if (liveEnabled) { stopLive(); return; }
  void startLive();
});

async function checkLiveConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/chat/live/config`, { signal: AbortSignal.timeout(5000) });
    const config = await response.json();
    liveAvailable = response.ok && config.enabled === true;
    if (!liveEnabled) {
      $('#live-status').textContent = liveAvailable ? readyPromptStatus : unavailableStatus;
    }
  } catch {
    liveAvailable = false;
    if (!liveEnabled) {
      $('#live-status').textContent = 'Não foi possível verificar a disponibilidade do Live.';
    }
  }
  updateControls();
}

$('#new-chat').addEventListener('click', () => {
  if (liveEnabled || liveStarting) stopLive();
  input.value = '';
  input.style.height = '';
  welcome();
  setState('idle');
  updateControls();
  input.focus();
  toast('Tudo pronto para uma nova conversa.');
});

function setConnection(online) {
  $('#connection').dataset.status = online ? 'online' : 'offline';
  $('#connection-label').textContent = online ? 'Assistente conectada' : 'Servidor indisponível';
}

async function checkConnection() {
  try {
    const response = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    const online = response.ok && data.status === 'online';
    setConnection(online);
    if (online) {
      void refreshAppearance().catch(() => {});
      if (!liveAvailable && !liveEnabled && !liveStarting) void checkLiveConfig();
    }
  } catch { setConnection(false); }
}

async function loadAvatar() {
  $('#avatar-loading').hidden = false;
  $('#avatar-error').hidden = true;
  try { await avatar.load(); await refreshAppearance(); }
  catch (error) {
    console.error('Live2D:', error);
    if (avatar.model) toast('Não foi possível carregar o visual padrão do servidor. Tentaremos novamente em instantes.', 'error');
    else $('#avatar-error').hidden = false;
  }
  finally {
    $('#avatar-loading').hidden = true;
  }
}
$('#retry-avatar').addEventListener('click', loadAvatar);

welcome();
setState('idle');
updateControls();
void loadAvatar();
void checkConnection();
void checkLiveConfig();

const healthInterval = setInterval(() => { if (!document.hidden) void checkConnection(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (liveStarting) {
      stopLive();
    } else if (liveEnabled) {
      pendingMic = false;
      void pauseLiveMic();
      livePlayer.interrupt(livePlayer.turn?.id);
      clearHiddenTimer();
      hiddenTimer = setTimeout(() => {
        if (document.hidden && liveEnabled) stopLive();
      }, HIDDEN_DISCONNECT_MS);
    }
    avatar.animation.stop();
  } else {
    clearHiddenTimer();
    if (liveEnabled && live.ready) {
      void livePlayer.unlock().catch(() => {});
    }
    void checkConnection();
  }
});
window.addEventListener('pagehide', () => {
  clearHiddenTimer();
  if (liveEnabled || liveStarting) stopLive();
  appearanceGeneration++;
  clearInterval(healthInterval);
  camera.destroy();
  avatar.destroy();
});
