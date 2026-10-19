import './style.css';
import './responsive.css';
import { icon, renderIcons } from './icons.js';
import { Avatar } from './avatar.js';
import { FaceTracking } from './camera.js';
import { VoicePlayer, VoiceRecorder } from './voice.js';

renderIcons();
const $ = selector => document.querySelector(selector);
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const history = $('#chat-history');
const input = $('#chat-input');
// Keep the avatar and composer in the visible area when the mobile keyboard opens.
function updateViewportHeight() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
window.visualViewport?.addEventListener('resize', updateViewportHeight);
window.addEventListener('resize', updateViewportHeight);
updateViewportHeight();
const avatar = new Avatar($('#avatar-canvas'));
$('#animation-toggle').addEventListener('click', () => {
  const options = $('#animation-options');
  options.hidden = !options.hidden;
  $('#animation-toggle').setAttribute('aria-expanded', String(!options.hidden));
});
$('#animation-select').addEventListener('change', event => {
  avatar.setPreview(event.target.value);
  $('#animation-toggle').textContent = avatar.preview
    ? `Teste: ${event.target.selectedOptions[0].textContent}`
    : 'Testar animações';
});
$('#animation-options').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('#animation-options').hidden = true;
    $('#animation-toggle').setAttribute('aria-expanded', 'false');
    $('#animation-toggle').focus();
  }
});
const recorder = new VoiceRecorder();
let sessionId = crypto.randomUUID();
let state = 'idle';
let busy = false;
let recording = false;
let micStarting = false;
let micGeneration = 0;
let cameraEnabled = false;
let voiceEnabled = true;
let requestController = null;
let speechController = null;
let questionGeneration = 0;
let recordTimer;
let toastTimer;
let emotionTimer;

const stateLabels = { idle: 'Pronta para ajudar', listening: 'Estou ouvindo você', thinking: 'Pensando na sua pergunta…', speaking: 'Uma resposta para você' };

function setState(next, emotion = 'neutral') {
  clearTimeout(emotionTimer);
  state = next;
  avatar.setState(next, emotion);
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

const player = new VoicePlayer($('#ai-audio'), (speaking, emotion) => {
  $('#stop-audio').hidden = !speaking;
  if (speaking) setState('speaking', emotion);
  else if (state === 'speaking') setState('idle');
}, level => { avatar.mouth = level; }, message => toast(message, 'error'));

function updateControls() {
  $('#send-btn').disabled = busy || recording || micStarting || !input.value.trim();
  $('#mic-btn').disabled = busy || micStarting;
  input.disabled = recording || micStarting;
  $('#mic-btn').setAttribute('aria-pressed', String(recording));
  $('#mic-btn').setAttribute('aria-label', recording ? 'Enviar áudio: terminar gravação e enviar pergunta' : micStarting ? 'Abrindo microfone' : 'Pode falar: gravar pergunta por voz');
  $('#mic-btn').innerHTML = `${icon(recording ? 'stop' : 'mic')}<span>${recording ? 'Enviar áudio' : micStarting ? 'Abrindo…' : 'Pode falar'}</span>`;
}

function scrollToLatest() { history.scrollTo({ top: history.scrollHeight, behavior: avatar.reducedMotion.matches ? 'instant' : 'smooth' }); }

function appendMessage(role, text, options = {}) {
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
  body.textContent = text; // Responses and transcripts are never interpreted as HTML.
  article.append(meta, body);
  if (role === 'assistant' && !options.welcome) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (options.audio_url || options.defer_audio) {
      const play = document.createElement('button');
      play.className = 'message-action';
      play.innerHTML = `${icon('volume')} Ouvir resposta`;
      play.addEventListener('click', async () => {
        if (busy || recording || micStarting) return toast('Termine sua pergunta antes de ouvir uma resposta.');
        const session = sessionId;
        play.disabled = true;
        try {
          await player.unlock();
          const path = await ensureAudio(options);
          if (session === sessionId && !busy && !recording && !micStarting) void player.play(audioUrl(path), options.emotion);
        } catch { toast('Não foi possível gerar o áudio. A resposta em texto continua disponível.', 'error'); }
        finally { play.disabled = false; }
      });
      actions.append(play);
    }
    const copy = document.createElement('button');
    copy.className = 'message-action';
    copy.innerHTML = `${icon('copy')} Copiar`;
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); toast('Resposta copiada.'); }
      catch { toast('Não foi possível copiar. Você pode selecionar o texto da resposta.', 'error'); }
    });
    actions.append(copy);
    article.append(actions);
  }
  if (options.retry) {
    const retry = document.createElement('button');
    retry.className = 'message-action';
    retry.innerHTML = `${icon('refresh')} Tentar novamente`;
    retry.addEventListener('click', () => { if (!busy && !recording && !micStarting) options.retry(); });
    article.append(retry);
  }
  history.append(article);
  scrollToLatest();
  return article;
}

function welcome() {
  history.replaceChildren();
  appendMessage('assistant', 'Como posso ajudar?', { welcome: true });
}

function pendingMessage(voice) {
  const article = document.createElement('article');
  article.className = 'message assistant';
  article.setAttribute('aria-label', voice ? 'Transcrevendo e preparando resposta' : 'Preparando resposta');
  article.innerHTML = `<div class="message-body thinking-bubble"><span></span><span></span><span></span><small>${voice ? 'Ouvindo sua pergunta…' : 'Buscando uma resposta…'}</small></div>`;
  history.append(article);
  scrollToLatest();
  return article;
}

function audioUrl(path) {
  // The API returns an absolute /static path, or a fully qualified HTTP URL.
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}/${path.replace(/^\/+/, '')}`;
}

async function ensureAudio(data, signal) {
  if (data.audio_url) return data.audio_url;
  if (!data.audioPromise) {
    data.audioPromise = (async () => {
      const response = await fetch(`${API_BASE}/api/chat/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: data.text_reply }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('Speech unavailable');
      const result = await response.json();
      if (!result.audio_url) throw new Error('Missing audio');
      data.audio_url = result.audio_url;
      return data.audio_url;
    })().finally(() => { data.audioPromise = null; });
  }
  return data.audioPromise;
}

async function submitQuestion({ text, blob, userMessage }) {
  if (busy || recording || micStarting) return;
  const generation = ++questionGeneration;
  busy = true;
  player.stop();
  setState('thinking');
  updateControls();
  if (!userMessage) userMessage = appendMessage('user', text || '🎙 Pergunta por voz');
  const pending = pendingMessage(Boolean(blob));
  const controller = new AbortController();
  requestController = controller;
  const currentSession = sessionId;
  const timeout = setTimeout(() => controller.abort('timeout'), 90000);
  try {
    let body;
    const headers = {};
    if (blob) {
      body = new FormData();
      body.append('audio_file', blob, 'pergunta.wav');
      body.append('user_id', currentSession);
      body.append('generate_audio', 'false');
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ message: text, user_id: currentSession, generate_audio: false });
    }
    const response = await fetch(`${API_BASE}/api/chat/${blob ? 'voice' : 'text'}`, { method: 'POST', headers, body, signal: controller.signal });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (blob && typeof error.detail?.transcribed_text === 'string' && error.detail.transcribed_text.trim()) {
        userMessage.querySelector('.message-body').textContent = error.detail.transcribed_text;
        toast('Áudio reconhecido. A transcrição está na conversa.');
        // Retry the recognized text without uploading or transcribing the audio again.
        text = error.detail.transcribed_text;
        blob = null;
      }
      if (typeof error.detail?.message === 'string') throw new Error(error.detail.message);
      throw new Error(typeof error.detail === 'string' ? error.detail : 'Não consegui acessar a universidade agora. Tente novamente em instantes.');
    }
    const data = await response.json();
    if (currentSession !== sessionId) return;
    if (typeof data.text_reply !== 'string' || !data.text_reply.trim()) throw new Error('A resposta chegou incompleta. Vamos tentar novamente?');
    if (data.transcribed_text) {
      userMessage.querySelector('.message-body').textContent = data.transcribed_text;
      toast('Áudio reconhecido. A transcrição está na conversa.');
    }
    data.defer_audio = true;
    let revealed = false;
    const reveal = () => {
      if (revealed || currentSession !== sessionId || generation !== questionGeneration) return;
      revealed = true;
      pending.remove();
      appendMessage('assistant', data.text_reply, data);
      if (state !== 'speaking') {
        setState('idle', data.emotion);
        emotionTimer = setTimeout(() => { if (state === 'idle') setState('idle'); }, 9000);
      }
    };
    if (voiceEnabled && !document.hidden) {
      const speech = new AbortController();
      speechController = speech;
      pending.querySelector('small').textContent = 'Preparando a voz…';
      try {
        const path = await ensureAudio(data, AbortSignal.any([controller.signal, speech.signal]));
        if (currentSession !== sessionId || generation !== questionGeneration) return;
        if (voiceEnabled && !speech.signal.aborted && !controller.signal.aborted && !document.hidden) {
          // Reveal only once playback really starts, not when TTS finishes.
          await player.play(audioUrl(path), data.emotion, reveal);
        }
      } catch {
        if (currentSession === sessionId && !speech.signal.aborted && !controller.signal.aborted) {
          toast('O áudio não ficou disponível. Você pode ler a resposta ou tentar ouvir novamente.', 'error');
        }
      } finally {
        if (speechController === speech) speechController = null;
      }
    }
    // Text remains accessible when muted, autoplay is blocked, or audio fails.
    reveal();
    if (currentSession !== sessionId) return;
    setConnection(true);
  } catch (error) {
    if (currentSession !== sessionId) return;
    pending.remove();
    const message = controller.signal.aborted ? 'A resposta demorou mais que o esperado. Tente novamente.' : error instanceof TypeError ? 'Não consegui me conectar ao servidor. Confira sua conexão e tente novamente.' : error.message;
    appendMessage('error', message, { retry: () => submitQuestion({ text, blob, userMessage }) });
    setState('idle', 'sad');
    if (error instanceof TypeError) setConnection(false);
  } finally {
    clearTimeout(timeout);
    pending.remove();
    if (currentSession === sessionId) {
      busy = false;
      requestController = null;
      updateControls();
    }
  }
}

function sendText(text = input.value.trim()) {
  text = text.trim();
  if (!text || busy || recording || micStarting) return;
  // Unlock audio during the user gesture, before the network request completes.
  if (voiceEnabled) player.unlock().catch(() => {});
  input.value = '';
  input.style.height = '';
  void submitQuestion({ text });
}

$('#chat-form').addEventListener('submit', event => { event.preventDefault(); sendText(); });
input.addEventListener('input', () => {
  input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  updateControls();
});
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendText(); }
});

function recordingUIOff() {
  clearInterval(recordTimer);
  recording = false;
  micStarting = false;
  $('#recording-panel').hidden = true;
  updateControls();
}

function cancelRecording() {
  micGeneration++;
  recorder.cancel();
  recordingUIOff();
  if (state === 'listening') setState('idle');
}

async function finishRecording() {
  if (!recording) return;
  const generation = micGeneration;
  recording = false;
  micStarting = true;
  clearInterval(recordTimer);
  updateControls();
  const blob = await recorder.stop();
  if (generation !== micGeneration) return;
  recordingUIOff();
  if (!blob || blob.size < 10000) { setState('idle'); toast('A gravação ficou muito curta. Toque no microfone e tente novamente.'); return; }
  void submitQuestion({ blob });
}

$('#mic-btn').addEventListener('click', async () => {
  if (recording) return finishRecording();
  if (busy || micStarting) return;
  const generation = ++micGeneration;
  player.stop();
  if (voiceEnabled) player.unlock().catch(() => {});
  micStarting = true;
  updateControls();
  try {
    const started = await recorder.start(() => { cancelRecording(); toast('O microfone foi desconectado. Tente gravar novamente.', 'error'); });
    if (!started || generation !== micGeneration) return;
    micStarting = false;
    recording = true;
    setState('listening');
    $('#recording-panel').hidden = false;
    $('#recording-time').textContent = '0:00';
    updateControls();
    const start = Date.now();
    recordTimer = setInterval(() => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      $('#recording-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds >= 60) void finishRecording();
    }, 250);
  } catch (error) {
    if (generation !== micGeneration) return;
    cancelRecording();
    toast(deviceError(error, 'microfone'), 'error');
  }
});
$('#cancel-recording').addEventListener('click', cancelRecording);

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
  if (!voiceEnabled) { speechController?.abort(); player.stop(); }
  else player.unlock().catch(() => {});
});
$('#stop-audio').addEventListener('click', () => player.stop());

$('#new-chat').addEventListener('click', () => {
  const previousSession = sessionId;
  sessionId = crypto.randomUUID();
  requestController?.abort();
  requestController = null;
  busy = false;
  cancelRecording();
  player.stop();
  input.value = '';
  input.style.height = '';
  welcome();
  setState('idle');
  updateControls();
  input.focus();
  fetch(`${API_BASE}/api/chat/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: previousSession }) }).catch(() => {});
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
    setConnection(response.ok && data.status === 'online');
  } catch { setConnection(false); }
}

async function loadAvatar() {
  $('#avatar-loading').hidden = false;
  $('#avatar-error').hidden = true;
  try { await avatar.load(); }
  catch (error) { console.error('Live2D:', error); $('#avatar-error').hidden = false; }
  finally { $('#avatar-loading').hidden = true; }
}
$('#retry-avatar').addEventListener('click', loadAvatar);

welcome();
setState('idle');
updateControls();
void loadAvatar();
void checkConnection();
const healthInterval = setInterval(() => { if (!document.hidden) void checkConnection(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (recording || micStarting) cancelRecording();
    speechController?.abort();
    player.stop();
  } else void checkConnection();
});
window.addEventListener('pagehide', () => {
  clearInterval(healthInterval);
  clearInterval(recordTimer);
  clearTimeout(emotionTimer);
  requestController?.abort();
  recorder.cancel(); camera.destroy(); player.destroy(); avatar.destroy();
});
