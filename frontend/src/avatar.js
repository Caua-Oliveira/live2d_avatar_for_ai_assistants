import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';

window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

const expressions = {
  neutral: { mouth: 0, smile: 0, brow: 0, eyes: 1, tilt: 0 },
  happy: {
    mouth: 1, open: .3, smile: 1, brow: .65, browY: .45, browForm: 1,
    eyes: .55, tilt: 14, headY: 9, bodyY: 3, bodyZ: 4,
  },
  sad: {
    mouth: -1, open: .2, smile: 0, brow: -1, browY: -.5, browForm: -1,
    eyes: .5, tilt: -13, headY: -16, bodyY: -7, bodyZ: -4,
    parameters: { Cry: 1, CryMouth: 1 },
  },
  listening: {
    mouth: .35, open: .12, smile: 0, brow: .8, browY: .8, browForm: .5,
    eyes: 1.2, tilt: -20, headX: -9, headY: 7, bodyX: -5, bodyZ: -5,
  },
  thinking: {
    mouth: -.7, smile: 0, brow: -.35, browY: -.2, browForm: -.5,
    eyes: .65, tilt: 19, headX: 16, headY: 13, eyeX: .65, eyeY: .65,
    bodyX: 5, bodyZ: 5,
    parameters: { ParamBrowRAngle: 1, ParamBrowRY: .9, ParamBrowRForm: 1 },
  },
};

export class Avatar {
  state = 'idle';
  emotion = 'neutral';
  gaze = { x: 0, y: 0 };
  faceFound = false;
  mouth = 0;
  values = {};
  expressionBlendMs = 110;
  eyeOpenness = 1;
  preview = null;
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(container) {
    this.container = container;
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
      this.model = await Live2DModel.from('/model/pestonini.model3.json', { autoInteract: false });
      this.model.eventMode = 'none';
      this.app.stage.addChild(this.model);
      this.model.anchor.set(.5, .5);
      this.resize();
      this.headBreath = (this.model.internalModel.breath?.getParameters() || [])
        .filter(parameter => ['ParamAngleX', 'ParamAngleY'].includes(parameter.parameterId))
        .map(parameter => ({ parameter, weight: parameter.weight }));
      // Override motion inputs before saveParameters and physics. Pestonini's
      // visible head/eyes use physics outputs (ParamAngleX2/3, EyeXPhys), so
      // writing only beforeModelUpdate is too late: physics sees the old input,
      // and loadParameters then discards the new gaze at the end of the frame.
      this.model.internalModel.on('afterMotionUpdate', () => this.update());
      this.model.internalModel.on('beforeModelUpdate', () => this.updateEyeOpenness());
    } finally {
      this.loading = false;
    }
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    this.app?.renderer.resize(width, height);
    if (!this.model) return;
    const { originalHeight, originalWidth } = this.model.internalModel;
    const scale = Math.min(height * 1.03 / originalHeight, width * .7 / originalWidth);
    this.model.scale.set(scale);
    this.model.position.set(width / 2, height * .51);
  }

  setState(state, emotion = 'neutral') {
    // Ease out of speech over ~2 seconds without slowing down lip sync.
    this.expressionBlendMs = this.state === 'speaking' && state === 'idle' && emotion === 'neutral' ? 600 : 110;
    this.state = state;
    this.emotion = Object.hasOwn(expressions, emotion) ? emotion : 'neutral';
  }

  setGaze(x = 0, y = 0, found = false) {
    this.gaze = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    this.faceFound = found;
  }

  setPreview(animation) {
    this.expressionBlendMs = 110;
    this.preview = animation === 'speaking' || Object.hasOwn(expressions, animation) ? animation : null;
  }

  get activeState() {
    return this.preview || this.state;
  }

  get activeExpression() {
    return expressions[this.activeState] || expressions[this.preview ? 'neutral' : this.emotion];
  }

  update() {
    const core = this.model.internalModel.coreModel;
    // The default breathing animation adds up to 7.5 degrees of head wander.
    // Keep body breathing, but let webcam gaze own the head direction.
    for (const { parameter, weight } of this.headBreath) {
      parameter.weight = this.faceFound || this.preview ? 0 : weight;
    }
    const now = performance.now() / 1000;
    const preset = this.activeExpression;
    const sway = this.reducedMotion.matches ? 0 : Math.sin(now * 1.4) * 1.3;
    // Manual previews own the pose; normal operation still follows the camera.
    const tracking = this.faceFound && !this.preview;
    const gaze = tracking ? this.gaze : { x: 0, y: 0 };
    const targets = {
      ParamMouthForm: preset.mouth,
      ParamMouthOpenY: this.activeState === 'speaking' ? (this.preview ? .5 + Math.sin(now * 12) * .45 : this.mouth) : preset.open || 0,
      ParamEyeLSmile: preset.smile, ParamEyeRSmile: preset.smile,
      ParamBrowLAngle: preset.brow, ParamBrowRAngle: preset.brow,
      ParamBrowLY: preset.browY || 0, ParamBrowRY: preset.browY || 0,
      ParamBrowLForm: preset.browForm || 0, ParamBrowRForm: preset.browForm || 0,
      ParamAngleZ: preset.tilt + sway,
      ParamAngleX: gaze.x * 16 + (tracking ? 0 : preset.headX || 0),
      ParamAngleY: gaze.y * 10 + (tracking ? 0 : preset.headY || 0),
      ParamEyeBallX: gaze.x * .75 + (tracking ? 0 : preset.eyeX || 0),
      ParamEyeBallY: gaze.y * .6 + (tracking ? 0 : preset.eyeY || 0),
      ParamBodyAngleX: preset.bodyX || 0,
      ParamBodyAngleY: preset.bodyY || 0,
      ParamBodyAngleZ: (preset.bodyZ || 0) + sway * .4,
      Cry: 0, CryMouth: 0, Droplet1: 0, HeadDent: 0, SweatDrop: 0,
      ...preset.parameters,
    };
    const delta = Math.min(this.app.ticker.deltaMS, 100);
    const blend = 1 - Math.exp(-delta / (this.reducedMotion.matches ? 110 : this.expressionBlendMs));
    const mouthBlend = 1 - Math.exp(-delta / 110);
    for (const [id, target] of Object.entries(targets)) {
      this.values[id] = (this.values[id] ?? target) + (target - (this.values[id] ?? target)) * (id === 'ParamMouthOpenY' ? mouthBlend : blend);
      core.setParameterValueById(id, this.values[id]);
    }
    this.eyeOpenness += (preset.eyes - this.eyeOpenness) * blend;
  }

  updateEyeOpenness() {
    const core = this.model.internalModel.coreModel;
    // Apply only after the blink controller runs; never persist this multiplier
    // into saveParameters, which would compound it across frames.
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) {
      core.setParameterValueById(id, core.getParameterValueById(id) * this.eyeOpenness);
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.app?.destroy(true, { children: true, texture: true, baseTexture: true });
  }
}
