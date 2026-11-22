import catalog from '../../shared/avatar-parameter-catalog.json' with { type: 'json' };

export const MODEL_PARAMETERS = catalog.parameters;
const MAX_KEYFRAMES = 16;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const eyes = new Set(['ParamEyeLOpen', 'ParamEyeROpen']);
const head = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];

export function normalizeAnimation(raw, parameters = MODEL_PARAMETERS) {
  if (raw?.model !== catalog.model || !Array.isArray(raw.tracks)) return [];
  const seen = new Set();
  const tracks = [];
  for (const track of raw.tracks.slice(0, Object.keys(parameters).length)) {
    if (!track || !Object.hasOwn(parameters, track.id) || seen.has(track.id) ||
        !['set', 'add', 'multiply'].includes(track.mode) || !Array.isArray(track.keyframes) ||
        !track.keyframes.length || track.keyframes.length > MAX_KEYFRAMES) continue;
    if (track.duration != null && (!finite(track.duration) || track.duration < .4 || track.duration > 4)) continue;
    let previous = -1;
    if (!track.keyframes.every(frame => {
      if (!frame || !finite(frame.at) || frame.at < 0 || frame.at > 1 || frame.at <= previous || !finite(frame.value)) return false;
      previous = frame.at;
      return true;
    })) continue;
    const control = parameters[track.id];
    let { min, max } = control;
    if (track.mode === 'add') [min, max] = [-(max - min), max - min];
    if (track.mode === 'multiply') [min, max] = [0, 2];
    tracks.push({ id: track.id, mode: track.mode, duration: track.duration ?? null, keyframes: track.keyframes.map(frame => ({
      at: frame.at, value: clamp(frame.value, min, max),
    })) });
    seen.add(track.id);
  }
  return tracks;
}

export function sampleTrack(track, progress, discrete = false) {
  const frames = track.keyframes;
  if (progress <= frames[0].at) return frames[0].value;
  for (let i = 1; i < frames.length; i++) {
    if (progress < frames[i].at) {
      const a = frames[i - 1], b = frames[i];
      if (discrete) return a.value;
      const t = (progress - a.at) / (b.at - a.at);
      const eased = t * t * (3 - 2 * t);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return frames.at(-1).value;
}

function segmentTimings(segments, timings, duration) {
  let end = 0;
  const valid = Array.isArray(timings) && timings.length === segments.length && timings.every((timing, i) => {
    if (!timing || !finite(timing.start) || !finite(timing.end) || timing.start < end || timing.end <= timing.start ||
        typeof timing.text !== 'string' || timing.text.trim().replace(/\s+/g, ' ') !== segments[i].text.trim().replace(/\s+/g, ' ')) return false;
    end = timing.end;
    return true;
  });
  if (valid) return timings;
  // Sem marcações reais de tempo, estima os limites dos segmentos pela contagem de palavras.
  const weights = segments.map(segment => Math.max(1, segment.text.trim().split(/\s+/).length));
  const total = weights.reduce((a, b) => a + b, 0);
  end = 0;
  return segments.map((segment, i) => {
    const start = end;
    end += duration * weights[i] / total;
    return { text: segment.text, start, end };
  });
}

function compose(base, track, control) {
  let value = base;
  if (track?.mode === 'set') value = track.value;
  if (track?.mode === 'add') value += track.value;
  if (track?.mode === 'multiply') value *= track.value;
  value = clamp(value, control.min, control.max);
  return control.type === 'choice' ? Math.round(value) : value;
}

function trackProgress(track, progress, seconds, availableDuration) {
  if (track.duration == null) return progress;
  const duration = availableDuration > 0 ? Math.min(track.duration, availableDuration) : track.duration;
  return clamp(seconds / duration, 0, 1);
}

// Controlador independente de FPS: o LLM gera uma partitura compacta por resposta
// e este módulo a executa localmente seguindo o relógio do áudio.
export class ParameterAnimation {
  constructor(parameters = MODEL_PARAMETERS, now = () => performance.now()) {
    this.parameters = parameters;
    this.now = now;
    this.tracks = [];
    this.segments = [];
    this.timings = [];
    this.segmentIndex = -1;
    this.values = new Map();
    this.releases = new Map();
    this.restoreValues = new Map();
    this.frame = new Map();
    this.headOffsets = new Map();
    this.headInputs = new Map();
  }

  get trackCount() {
    return this.tracks.length + this.segments.reduce((sum, segment) => sum + segment.tracks.length, 0);
  }

  play(animation, { audio = null, durationMs = 6000, audioDuration = null, segments = [] } = {}) {
    this.tracks = normalizeAnimation(animation, this.parameters);
    this.segments = animation?.model === catalog.model && Array.isArray(animation.segments)
      ? animation.segments.slice(0, 8).filter(s => typeof s?.text === 'string' && s.text.trim()).map(s => ({
        text: s.text, tracks: normalizeAnimation({ model: catalog.model, tracks: s.tracks }, this.parameters),
      })) : [];
    this.audio = audio;
    this.started = this.now();
    this.durationMs = finite(durationMs) ? clamp(durationMs, 1000, 30000) : 6000;
    this.audioDuration = finite(audioDuration) && audioDuration > 0 ? audioDuration : null;
    const duration = this.audioDuration || (finite(audio?.duration) && audio.duration > 0 ? audio.duration : this.durationMs / 1000);
    this.timings = segmentTimings(this.segments, segments, duration);
    return this.trackCount;
  }

  stop() {
    this.tracks = [];
    this.segments = [];
    this.timings = [];
    this.segmentIndex = -1;
    this.audio = null;
  }

  sample() {
    let progress = 0;
    let time = 0;
    let duration = this.durationMs / 1000;
    if (this.audio) {
      if (this.audio.ended) this.stop();
      else if (finite(this.audio.currentTime)) {
        time = this.audio.currentTime;
        duration = finite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : this.audioDuration;
        if (duration) progress = clamp(time / duration, 0, 1);
      }
    } else {
      time = (this.now() - this.started) / 1000;
      progress = clamp(time * 1000 / this.durationMs, 0, 1);
      if (progress >= 1) this.stop();
    }
    const result = new Map(this.tracks.map(track => [track.id, {
      mode: track.mode,
      value: sampleTrack(track, trackProgress(track, progress, time, duration), this.parameters[track.id].type === 'choice'),
    }]));
    const index = this.timings?.findIndex(timing => time >= timing.start && time < timing.end) ?? -1;
    this.segmentIndex = index;
    if (index >= 0 && this.segments[index]) {
      const timing = this.timings[index];
      const local = clamp((time - timing.start) / (timing.end - timing.start), 0, 1);
      for (const track of this.segments[index].tracks) result.set(track.id, {
        mode: track.mode, value: sampleTrack(track,
          trackProgress(track, local, time - timing.start, timing.end - timing.start), this.parameters[track.id].type === 'choice'),
      });
    }
    return result;
  }

  // O Cubism salva os parâmetros após afterMotionUpdate e os recarrega no fim do quadro.
  // Restaura os valores originais antes do próximo ciclo para evitar acúmulo em tracks
  // add/multiply e impedir que mudanças temporárias de aparência fiquem permanentes.
  restore(core, { idleSmile } = {}) {
    for (const [id, value] of this.restoreValues) core.setParameterValueById(id, value);
    this.restoreValues.clear();
    if (idleSmile !== undefined) {
      this.idleSmile = idleSmile;
      core.setParameterValueById('ParamMouthForm', idleSmile ? .3 : 0);
    }
  }

  smooth(id, base, track) {
    const control = this.parameters[id];
    const old = this.values.get(id);
    if (!track) {
      const release = this.releases.get(id) ?? { elapsed: 0, source: old };
      release.elapsed += this.delta;
      if (!old || control.type === 'choice' || release.elapsed >= 500 || (id === 'ParamMouthForm' && this.reducedMotion)) {
        this.values.delete(id);
        this.releases.delete(id);
        return base;
      }
      this.releases.set(id, release);
      const t = release.elapsed / 500;
      const weight = 1 - t * t * (3 - 2 * t);
      const source = release.source;
      const neutral = source.mode === 'set' ? base : source.mode === 'add' ? 0 : 1;
      const operation = { mode: source.mode, value: neutral + (source.value - neutral) * weight };
      this.values.set(id, operation);
      return compose(base, operation, control);
    }
    this.releases.delete(id);
    const mode = track?.mode ?? old?.mode ?? 'set';
    const neutral = mode === 'add' ? 0 : mode === 'multiply' ? 1 : base;
    const target = track?.value ?? neutral;
    let previous = old?.value ?? neutral;
    if (old && old.mode !== mode) {
      const displayed = compose(base, old, control);
      previous = mode === 'set' ? displayed : mode === 'add' ? displayed - base : base ? displayed / base : 1;
    }
    const blend = id === 'ParamMouthForm' && this.reducedMotion ? 1 : 1 - Math.exp(-this.delta / this.transitionMs);
    const value = control.type === 'choice' ? target : previous + (target - previous) * blend;
    // Suaviza o multiplicador/offset em si, não a base variável — assim piscadas (0)
    // fecham totalmente e a abertura labial não sofre dupla suavização.
    const operation = { mode, value };
    this.values.set(id, operation);
    return compose(base, operation, control);
  }

  beforePhysics(core, deltaMs, reducedMotion = false, { secondaryMotion = {} } = {}) {
    this.delta = finite(deltaMs) ? clamp(deltaMs, 0, 100) : 0;
    this.reducedMotion = reducedMotion;
    this.transitionMs = reducedMotion ? 180 : 90;
    this.samples = this.sample();
    this.secondaryMotion = reducedMotion ? {} : secondaryMotion;
    this.frame.clear();
    // A respiração roda após este gancho; guarda sua última contribuição para que entrada
    // e retorno interpolem a partir da pose visível da cabeça sem perder a física.
    for (const id of head) this.headInputs.set(id, core.getParameterValueById(id));
    const ids = new Set([...this.values.keys(), ...this.samples.keys()]);
    for (const id of ids) {
      const control = this.parameters[id];
      // Saídas de física e olhos precisam do resultado real de física/piscada como base.
      if (control.physicsOutput || eyes.has(id)) {
        this.frame.set(id, null);
        continue;
      }
      const base = core.getParameterValueById(id);
      let sample = this.samples.get(id);
      // O sorriso em repouso é apenas postura base: offsets/multiplicadores atuam a partir
      // do zero neutro e o retorno volta à base atual sem viés de +0.3 nem salto visual.
      if (id === 'ParamMouthForm' && this.idleSmile !== undefined && sample) {
        sample = { mode: 'set', value: compose(0, sample, control) };
      }
      const value = this.smooth(id, base + (this.headOffsets.get(id) ?? 0), sample);
      if (this.values.has(id)) {
        this.restoreValues.set(id, base);
        core.setParameterValueById(id, value);
        this.frame.set(id, value);
      }
    }
  }

  afterPhysics(core) {
    for (const id of head) {
      const input = this.frame.get(id) ?? this.headInputs.get(id);
      this.headOffsets.set(id, core.getParameterValueById(id) - input);
    }
    for (const [id, earlyValue] of this.frame) {
      const value = earlyValue ?? this.smooth(id, core.getParameterValueById(id), this.samples.get(id));
      core.setParameterValueById(id, value);
    }
    // Poses absolutas estáticas de cabeça/corpo apagam todo movimento automático.
    // Aplica apenas um pequeno deslocamento no momento do render sem realimentar física,
    // suavização ou parâmetros salvos; tracks com variação mantêm controle total do eixo.
    const active = new Map(this.tracks.map(track => [track.id, track]));
    for (const track of this.segments[this.segmentIndex]?.tracks ?? []) active.set(track.id, track);
    for (const [id, offset] of Object.entries(this.secondaryMotion ?? {})) {
      if (!head.includes(id) && !['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'].includes(id)) continue;
      const track = active.get(id);
      if (track?.mode !== 'set' || !track.keyframes.every(frame => frame.value === track.keyframes[0].value)) continue;
      const control = this.parameters[id];
      core.setParameterValueById(id, clamp(core.getParameterValueById(id) + offset, control.min, control.max));
    }
  }
}
