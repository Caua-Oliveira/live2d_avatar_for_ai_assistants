import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { MODEL_URL, getAppearanceControls, normalizeAppearance } from './avatar-appearance.js';
import { MODEL_PARAMETERS, ParameterAnimation } from './avatar-animation.js';
import { headBreathTarget, secondaryMotion } from './avatar-motion.js';

window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

// Feedback visual local enquanto aguarda entrada ou rede. Respostas faladas não usam
// presets fixos: as tracks geradas pela IA são aplicadas pelo controlador de animação.
const activityPoses = {
  // O sorriso em repouso é restaurado antes do ciclo de movimento, separado das tracks de boca.
  idle: {},
  listening: {
    ParamMouthForm: .2, Param47: -.25, ParamBrowLY: .65, ParamBrowRY: .65,
    ParamBrowLForm: .35, ParamBrowRForm: .35, ParamAngleZ: -10,
    ParamAngleX: -6, ParamAngleY: 5, Param48: .7,
  },
  thinking: {
    ParamMouthForm: -.35, Param47: .2, ParamBrowLY: -.15, ParamBrowRY: .65,
    ParamBrowLForm: -.35, ParamBrowRForm: .75, ParamAngleZ: 12,
    ParamAngleX: 12, ParamAngleY: 9, ParamEyeBallX: .5, ParamEyeBallY: .5, Param48: .35,
  },
};
const activityParameters = [...new Set(Object.values(activityPoses).flatMap(pose => Object.keys(pose)))];

export class Avatar {
  state = 'idle';
  gaze = { x: 0, y: 0 };
  faceFound = false;
  mouth = 0;
  values = {};
  headBreathWeight = 1;
  animation = new ParameterAnimation();
  appearance = {};
  appearanceControls = [];
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(container, { framing = 'portrait' } = {}) {
    this.container = container;
    this.framing = framing;
  }

  async load() {
    if (this.loading || this.model) return;
    this.loading = true;
    try {
      if (!this.app) {
        this.app = new PIXI.Application({
          backgroundAlpha: 0, antialias: true, autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          width: this.container.clientWidth, height: this.container.clientHeight,
        });
        this.container.appendChild(this.app.view);
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.container);
      }
      this.model = await Live2DModel.from(MODEL_URL, { autoInteract: false });
      const core = this.model.internalModel.coreModel;
      if (core.getParameterCount() !== Object.keys(MODEL_PARAMETERS).length) {
        this.model.destroy();
        this.model = null;
        throw new Error('Avatar parameter count does not match the loaded model.');
      }
      for (const [id, info] of Object.entries(MODEL_PARAMETERS)) {
        const index = core.getParameterIndex(id);
        if (index >= core.getParameterCount() || core.getParameterMinimumValue(index) !== info.min ||
            core.getParameterMaximumValue(index) !== info.max) {
          this.model.destroy();
          this.model = null;
          throw new Error('Avatar parameter catalog does not match the loaded model.');
        }
      }
      this.appearanceControls = getAppearanceControls(this.model.internalModel.coreModel);
      this.setAppearance(normalizeAppearance({}, this.appearanceControls));
      this.model.eventMode = 'none';
      this.app.stage.addChild(this.model);
      this.model.anchor.set(.5, .5);
      this.resize();
      this.headBreath = (this.model.internalModel.breath?.getParameters() || [])
        .filter(parameter => ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'].includes(parameter.parameterId))
        .map(parameter => ({ parameter, weight: parameter.weight }));
      this.model.internalModel.on('beforeMotionUpdate', () => this.animation.restore(core, {
        idleSmile: this.state === 'idle' || this.state === 'speaking',
      }));
      this.model.internalModel.on('afterMotionUpdate', () => this.update());
      this.model.internalModel.on('beforeModelUpdate', () => {
        this.applyAppearance();
        this.animation.afterPhysics(core);
      });
    } finally {
      this.loading = false;
    }
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    this.app?.renderer.resize(width, height);
    if (!this.model) return;
    // Aproxima o retrato do rosto da MO recortando o corpo inferior; escala pela altura
    // para que telas estreitas não voltem ao enquadramento de corpo inteiro.
    const { originalHeight } = this.model.internalModel;
    const fullBody = this.framing === 'full';
    const scale = height * (fullBody ? .94 : 2.55) / originalHeight;
    this.model.scale.set(scale);
    this.model.position.set(width / 2, height * (fullBody ? .5 : 1.12));
  }

  setAppearance(parameters) {
    this.appearance = normalizeAppearance(parameters, this.appearanceControls);
    this.applyAppearance();
  }

  applyAppearance() {
    const core = this.model?.internalModel.coreModel;
    if (!core) return;
    for (const [id, value] of Object.entries(this.appearance)) core.setParameterValueById(id, value);
  }

  setState(state, animation = null, playback = {}) {
    this.state = state;
    if (animation) return this.animation.play(animation, playback);
    else this.animation.stop();
    return 0;
  }

  setGaze(x = 0, y = 0, found = false) {
    this.gaze = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    this.faceFound = found;
  }

  update() {
    const core = this.model.internalModel.coreModel;
    this.applyAppearance();
    const delta = Math.max(0, Math.min(this.app.ticker.deltaMS, 100));
    const idleBlend = 1 - Math.exp(-delta / 220);
    const idleTarget = headBreathTarget({ tracking: this.faceFound,
      expressing: this.animation.trackCount > 0, reducedMotion: this.reducedMotion.matches });
    this.headBreathWeight += (idleTarget - this.headBreathWeight) * idleBlend;
    // A respiração padrão adiciona até 7,5 graus de oscilação na cabeça; mantém a
    // respiração do corpo, mas deixa o rastreamento facial controlar a direção da cabeça.
    for (const { parameter, weight } of this.headBreath) {
      parameter.weight = weight * this.headBreathWeight;
    }
    const now = performance.now() / 1000;
    const pose = activityPoses[this.state] || {};
    const sway = Math.sin(now * 1.4) * 1.3 * this.headBreathWeight;
    const tracking = this.faceFound;
    const gaze = tracking ? this.gaze : { x: 0, y: 0 };
    const targets = Object.fromEntries(activityParameters.map(id => [id, pose[id] ?? MODEL_PARAMETERS[id].default]));
    if (this.state === 'idle' || this.state === 'speaking') delete targets.ParamMouthForm;
    targets.ParamMouthOpenY = this.state === 'speaking' ? Math.max(0, Math.min(1, this.mouth)) : 0;
    targets.ParamAngleZ += sway;
    targets.ParamAngleX = gaze.x * 16 + (tracking ? 0 : targets.ParamAngleX);
    targets.ParamAngleY = gaze.y * 10 + (tracking ? 0 : targets.ParamAngleY);
    targets.ParamEyeBallX = gaze.x * .75 + (tracking ? 0 : targets.ParamEyeBallX);
    targets.ParamEyeBallY = gaze.y * .6 + (tracking ? 0 : targets.ParamEyeBallY);
    targets.Param156 = 1;
    const blend = 1 - Math.exp(-delta / 110);
    for (const [id, target] of Object.entries(targets)) {
      const previous = this.values[id] ?? target;
      this.values[id] = previous + (target - previous) * blend;
      core.setParameterValueById(id, this.values[id]);
    }
    this.animation.beforePhysics(core, delta, this.reducedMotion.matches, {
      secondaryMotion: secondaryMotion(now, { tracking, reducedMotion: this.reducedMotion.matches }),
    });
  }

  destroy() {
    this.animation.stop();
    this.observer?.disconnect();
    this.app?.destroy(true, { children: true, texture: true, baseTexture: true });
  }
}
