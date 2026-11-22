import { VoiceRecorder } from './voice.js';

const MAX_LIVE_QUEUE_SECONDS = 120;

// Preserva a posição fracionária entre blocos do worklet (inclusive em 44,1 kHz).
export class PCMResampler {
  constructor(inputRate, outputRate = 16000) {
    this.ratio = inputRate / outputRate;
    this.pending = new Float32Array();
    this.position = 0;
  }
  push(samples) {
    const input = new Float32Array(this.pending.length + samples.length);
    input.set(this.pending); input.set(samples, this.pending.length);
    const output = [];
    while (this.position + 1 < input.length) {
      const i = Math.floor(this.position), fraction = this.position - i;
      output.push(input[i] * (1 - fraction) + input[i + 1] * fraction);
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), input.length);
    this.pending = input.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }
}

export function encodePCM(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((value, i) => {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePCM(data) {
  const binary = atob(data);
  if (!binary.length || binary.length % 2) throw new Error('Áudio Live inválido.');
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer), samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

// O relógio sintético avança apenas sobre o PCM agendado, congelando em lacunas de buffer.
export class LivePlayer {
  constructor({ onSpeech = () => {}, onLevel = () => {}, onStart = () => {} } = {}) {
    Object.assign(this, { onSpeech, onLevel, onStart });
    this.sources = new Set(); this.retired = new Set(); this.pendingAnimations = new Map();
    this.deferred = []; this.completed = new Set(); this.deferredSeconds = 0;
    this.muted = false; this.speaking = false;
  }
  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 256;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.gain = this.context.createGain();
      this.analyser.connect(this.gain); this.gain.connect(this.context.destination);
    }
    await this.context.resume();
  }
  setMuted(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    if (muted) this.onLevel(0);
  }
  retire(id) {
    if (id == null) return;
    this.retired.add(id); this.pendingAnimations.delete(id);
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value);
  }
  enqueue(event) {
    if (this.retired.has(event.turn_id)) return;
    if (!this.context || this.context.state !== 'running') throw new Error('O áudio Live foi suspenso. Reconecte a conversa.');
    const rate = event.sample_rate || 24000;
    if (!Number.isFinite(rate) || rate < 8000 || rate > 96000) throw new Error('Taxa de áudio Live inválida.');
    const samples = decodePCM(event.data);
    const seconds = samples.length / rate;
    // Contabiliza o bloco inteiro recebido e limita as filas agendada e adiada separadamente,
    // permitindo que um turno recuperado aguarde o turno atual terminar sem cortá-lo.
    const scheduledSeconds = this.turn?.intervals.reduce((sum, interval) => sum +
      Math.max(0, interval.end - Math.max(interval.start, this.context.currentTime)), 0) ?? 0;
    if (this.turn && this.turn.id !== event.turn_id && !this.clock.ended) {
      if (this.deferredSeconds + seconds > MAX_LIVE_QUEUE_SECONDS + 1e-7) {
        throw new Error('A fila de áudio Live excedeu o limite. Reconecte.');
      }
      this.deferred.push(event); this.deferredSeconds += seconds;
      return;
    }
    if (scheduledSeconds + seconds > MAX_LIVE_QUEUE_SECONDS + 1e-7) {
      throw new Error('A fila de áudio Live excedeu o limite. Reconecte.');
    }
    if (this.turn?.id !== event.turn_id) {
      const score = this.pendingAnimations.get(event.turn_id);
      this.clear(true);
      const turn = this.turn = { id: event.turn_id, duration: 0, intervals: [], complete: this.completed.has(event.turn_id), score, animation: score?.animation };
      const context = this.context;
      this.clock = {
        get currentTime() { return turn.intervals.reduce((sum, interval) => sum + Math.max(0, Math.min(interval.end, context.currentTime) - interval.start), 0); },
        get duration() { return turn.duration; },
        get paused() { return turn.cancelled || !turn.intervals.some(i => context.currentTime >= i.start && context.currentTime < i.end); },
        get ended() { return turn.cancelled || (turn.complete && !turn.intervals.some(i => context.currentTime < i.end)); },
      };
    }
    const turn = this.turn;
    const start = Math.max(this.context.currentTime + .02, turn.intervals.at(-1)?.end || 0);
    const buffer = this.context.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.analyser);
    const end = start + buffer.duration;
    turn.intervals.push({ start, end }); turn.duration += buffer.duration;
    this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    source.start(start);
    if (!this.frame) this.tick();
  }
  tick() {
    const active = Boolean(this.turn && !this.clock.paused);
    if (active !== this.speaking) {
      this.speaking = active;
      if (active) this.onStart(this.turn.id);
    }
    // Um underrun apenas congela o relógio da partitura, sem pará-la nem reiniciá-la.
    if (active && (!this.turn.announced || this.turn.scorePending)) this.attachScore();
    let rms = 0;
    if (active && !this.muted) {
      this.analyser.getFloatTimeDomainData(this.samples);
      rms = Math.sqrt(this.samples.reduce((sum, sample) => sum + sample * sample, 0) / this.samples.length) * 5;
    }
    this.onLevel(Math.min(1, rms));
    if (this.clock?.ended) { this.advance(); return; }
    this.frame = requestAnimationFrame(() => this.tick());
  }
  animation(event) {
    if (this.retired.has(event.turn_id)) return;
    const score = {
      animation: event.animation,
      audioDuration: Number.isFinite(event.audio_duration) && event.audio_duration > 0 ? event.audio_duration : null,
      audioSegments: Array.isArray(event.audio_segments) ? event.audio_segments : [],
    };
    if (this.turn?.id === event.turn_id) {
      if (this.clock.ended) return;
      if (JSON.stringify(this.turn.score) === JSON.stringify(score)) return;
      this.turn.score = score;
      this.turn.animation = event.animation;
      this.turn.scorePending = true;
      if (!this.clock.paused) this.attachScore();
    } else {
      this.pendingAnimations.set(event.turn_id, score);
      if (this.pendingAnimations.size > 8) this.pendingAnimations.delete(this.pendingAnimations.keys().next().value);
    }
  }
  attachScore() {
    const turn = this.turn, audio = this.clock;
    if (!turn || audio.paused || audio.ended) return;
    if (turn.animation && (!turn.scoreClock || turn.scorePending)) {
      // Partituras com áudio em buffer descrevem a fala inteira, usando a duração real e o
      // relógio desde o início do turno; partituras em streaming legado ainda partem do instante de anexo.
      const attachedAt = turn.score?.audioDuration ? 0 : audio.currentTime;
      const duration = turn.score?.audioDuration ?? Math.max(6, turn.complete ? audio.duration - attachedAt : 0);
      turn.scoreClock = {
        get currentTime() { return Math.max(0, audio.currentTime - attachedAt); },
        duration,
        get paused() { return audio.paused; },
        get ended() { return audio.ended; },
      };
    }
    turn.announced = true; turn.scorePending = false;
    this.onSpeech(true, turn.animation, turn.scoreClock || audio, {
      audioDuration: turn.score?.audioDuration,
      segments: turn.score?.audioSegments ?? [],
    });
  }
  complete(id) {
    if (this.turn?.id === id) this.turn.complete = true;
    else if (this.deferred.some(event => event.turn_id === id)) this.completed.add(id);
    else this.retire(id);
  }
  interrupt(id) {
    this.deferred = this.deferred.filter(event => event.turn_id !== id);
    this.deferredSeconds = this.deferred.reduce((sum, event) => sum + atob(event.data).length / 2 / (event.sample_rate || 24000), 0);
    if (id == null) this.clear();
    else if (this.turn?.id === id) this.advance();
    this.retire(id);
  }
  advance() {
    const events = this.deferred;
    this.deferred = []; this.deferredSeconds = 0;
    this.clear(true);
    for (const event of events) this.enqueue(event);
  }
  clear(keepQueue = false) {
    cancelAnimationFrame(this.frame); this.frame = null;
    if (this.turn) this.turn.cancelled = true;
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.retire(this.turn?.id); this.completed.delete(this.turn?.id); this.turn = null; this.clock = null;
    if (!keepQueue) { this.deferred = []; this.deferredSeconds = 0; this.completed.clear(); }
    this.speaking = false; this.onLevel(0); this.onSpeech(false);
  }
  destroy() { this.clear(); this.pendingAnimations.clear(); this.retired.clear(); this.context?.close().catch(() => {}); }
}

export class LiveSession {
  constructor(base, callbacks = {}) {
    this.base = base; this.callbacks = callbacks; this.recorder = new VoiceRecorder(); this.generation = 0;
  }
  connect() {
    this.disconnect();
    const generation = this.generation;
    const url = new URL(`${this.base}/api/chat/live`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    const timeout = setTimeout(() => this.fail('A conexão Live demorou demais.'), 15000);
    socket.onmessage = ({ data }) => {
      if (generation !== this.generation) return;
      try {
        const event = JSON.parse(data);
        if (event.type === 'ready') { clearTimeout(timeout); this.ready = true; }
        if (event.type === 'error') { this.fail(event.message || 'Falha na conversa Live.'); return; }
        this.callbacks.onEvent?.(event);
      } catch (error) { this.fail(error.message || 'Evento Live inválido.'); }
    };
    socket.onerror = () => { if (generation === this.generation) this.fail('Não foi possível conectar ao Live.'); };
    socket.onclose = () => { clearTimeout(timeout); if (generation === this.generation) this.fail('Conversa Live desconectada.'); };
    this.timeout = timeout;
  }
  send(event) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Aguarde a conexão Live.');
    if (this.socket.bufferedAmount > 1024 * 1024) throw new Error('Conexão Live lenta demais. Reconecte.');
    this.socket.send(JSON.stringify(event));
  }
  async startMic() {
    const generation = this.generation;
    this.resampler = null;
    return this.recorder.start(() => { this.stopMic(); this.callbacks.onMicEnded?.(); }, (samples, rate) => {
      if (generation !== this.generation) return;
      try {
        this.resampler ||= new PCMResampler(rate);
        const pcm = this.resampler.push(samples);
        if (pcm.length) this.send({ type: 'audio', data: encodePCM(pcm) });
      } catch (error) { this.fail(error.message); }
    });
  }
  async stopMic() {
    const generation = this.generation;
    // Descarrega o último bloco parcial do worklet antes de sinalizar o fim da fala.
    await this.recorder.stop();
    if (generation !== this.generation) return;
    this.resampler = null;
    if (this.ready) {
      try { this.send({ type: 'audio_end' }); } catch (error) { this.fail(error.message); }
    }
  }
  fail(message) { this.disconnect(); this.callbacks.onError?.(message); }
  disconnect() {
    this.generation++; clearTimeout(this.timeout); this.recorder.cancel();
    const socket = this.socket; this.socket = null;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }));
      socket.close();
    }
    this.ready = false;
  }
}
