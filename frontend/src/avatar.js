import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';
import { MODEL_URL, getAppearanceControls, normalizeAppearance } from './avatar-appearance.js';

window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

// MO's rig uses brow height/form and Param47 (brow shape), not brow angles.
// Ranges verified against MO.moc3; labels are in MO.cdi3.json.
const expressions = {
  neutral: { mouth: 0, smile: 0, brow: 0, eyes: 1, tilt: 0 },
  happy: {
    mouth: 1, open: .25, smile: 1, brow: -.45, browY: .35, browForm: .65,
    eyes: .65, tilt: 8, headY: 6,
  },
  sad: {
    mouth: -.85, open: .08, smile: 0, brow: .7, browY: -.35, browForm: -1,
    eyes: .65, tilt: -9, headY: -12,
  },
  listening: {
    mouth: .2, open: .08, smile: 0, brow: -.25, browY: .65, browForm: .35,
    eyes: 1, tilt: -10, headX: -6, headY: 5,
    parameters: { Param48: .7 },
  },
  thinking: {
    mouth: -.35, smile: 0, brow: .2, browY: -.15, browForm: -.35,
    eyes: .8, tilt: 12, headX: 12, headY: 9, eyeX: .5, eyeY: .5,
    parameters: { ParamBrowRY: .65, ParamBrowRForm: .75, Param48: .35 },
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
      this.appearanceControls = getAppearanceControls(this.model.internalModel.coreModel);
      this.setAppearance(normalizeAppearance({}, this.appearanceControls));
      this.model.eventMode = 'none';
      this.app.stage.addChild(this.model);
      this.model.anchor.set(.5, .5);
      this.resize();
      this.headBreath = (this.model.internalModel.breath?.getParameters() || [])
        .filter(parameter => ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'].includes(parameter.parameterId))
        .map(parameter => ({ parameter, weight: parameter.weight }));
      // Set MO's head, gaze and mouth inputs before saveParameters and physics,
      // so the body, hair and facial secondary motion follow the current pose.
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
    // Tighten the portrait around MO's face; clip the lower body.
    // Scale by height so narrow layouts do not zoom back out to a full-body view.
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

  setState(state, emotion = 'neutral') {
    // Ease out of speech over ~2 seconds without slowing down lip sync.
    this.expressionBlendMs = this.state === 'speaking' && state === 'idle' && emotion === 'neutral' ? 600 : 110;
    this.state = state;
    this.emotion = ['happy', 'sad'].includes(emotion) ? emotion : 'neutral';
  }

  setGaze(x = 0, y = 0, found = false) {
    this.gaze = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    this.faceFound = found;
  }

  get activeExpression() {
    return expressions[this.state] || expressions[this.emotion];
  }

  update() {
    const core = this.model.internalModel.coreModel;
    this.applyAppearance();
    // The default breathing animation adds up to 7.5 degrees of head wander.
    // Keep body breathing, but let webcam gaze own the head direction.
    for (const { parameter, weight } of this.headBreath) {
      parameter.weight = this.faceFound ? 0 : weight;
    }
    const now = performance.now() / 1000;
    const preset = this.activeExpression;
    const sway = this.reducedMotion.matches ? 0 : Math.sin(now * 1.4) * 1.3;
    const tracking = this.faceFound;
    const gaze = tracking ? this.gaze : { x: 0, y: 0 };
    const targets = {
      ParamMouthForm: preset.mouth,
      ParamMouthOpenY: this.state === 'speaking' ? Math.max(0, Math.min(1, this.mouth)) : preset.open || 0,
      ParamEyeLSmile: preset.smile, ParamEyeRSmile: preset.smile,
      Param47: preset.brow,
      ParamBrowLY: preset.browY || 0, ParamBrowRY: preset.browY || 0,
      ParamBrowLForm: preset.browForm || 0, ParamBrowRForm: preset.browForm || 0,
      ParamAngleZ: preset.tilt + sway,
      ParamAngleX: gaze.x * 16 + (tracking ? 0 : preset.headX || 0),
      ParamAngleY: gaze.y * 10 + (tracking ? 0 : preset.headY || 0),
      ParamEyeBallX: gaze.x * .75 + (tracking ? 0 : preset.eyeX || 0),
      ParamEyeBallY: gaze.y * .6 + (tracking ? 0 : preset.eyeY || 0),
      // MO's physics owns body angles. Param48 is its large-eye control,
      // with a compiled default of .5; reset it when leaving a custom pose.
      Param48: .5,
      // MO's built-in "Watermark off" switch hides the social-account text.
      Param156: 1,
      ...preset.parameters,
    };
    const delta = Math.min(this.app.ticker.deltaMS, 100);
    const blend = 1 - Math.exp(-delta / (this.reducedMotion.matches ? 110 : this.expressionBlendMs));
    const mouthBlend = 1 - Math.exp(-delta / 110);
    targets.ParamEyeLOpen = targets.ParamEyeROpen = preset.eyes;
    for (const [id, target] of Object.entries(targets)) {
      const eye = id === 'ParamEyeLOpen' || id === 'ParamEyeROpen';
      const previous = this.values[id] ?? (eye ? this.eyeOpenness : target);
      this.values[id] = previous + (target - previous) * (id === 'ParamMouthOpenY' ? mouthBlend : blend);
      // Openness is applied as a multiplier after the natural blink controller.
      if (!eye) core.setParameterValueById(id, this.values[id]);
    }
    this.eyeOpenness += (preset.eyes - this.eyeOpenness) * blend;
  }

  updateEyeOpenness() {
    const core = this.model.internalModel.coreModel;
    // Keep the selected look authoritative even when physics touches an input.
    this.applyAppearance();
    // Apply only after the blink controller runs; never persist this multiplier
    // into saveParameters, which would compound it across frames.
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) {
      core.setParameterValueById(id, core.getParameterValueById(id) * (this.values[id] ?? this.eyeOpenness));
    }
    // MO's mouth physics overwrites all four smile outputs. Keep the smoothed
    // expression (including the auxiliary smile rig) authoritative at render time.
    core.setParameterValueById('ParamEyeLSmile', this.values.ParamEyeLSmile);
    core.setParameterValueById('ParamEyeRSmile', this.values.ParamEyeRSmile);
    core.setParameterValueById('Param190', this.values.ParamEyeLSmile);
    core.setParameterValueById('Param191', this.values.ParamEyeRSmile);
  }

  destroy() {
    this.observer?.disconnect();
    this.app?.destroy(true, { children: true, texture: true, baseTexture: true });
  }
}
