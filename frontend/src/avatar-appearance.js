export const MODEL_VERSION = 'MO.v2.7';
export const MODEL_URL = `/${MODEL_VERSION}/MO.model3.json`;
const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '').replace(/\/$/, '');

// Only appearance inputs belong here, never tracking/physics outputs or the
// rig's decorative headings. Limits and defaults come from the compiled model.
const groups = [
  ['hair', 'Cabelo', [
    ['Param20', 'Estilo da franja', 'choice'],
    ['Param5', 'Comprimento da franja'], ['Param140', 'Largura da franja'],
    ['Param103', 'Franja direita', 'choice'], ['Param108', 'Franja esquerda', 'choice'],
    ['Param106', 'Comprimento da franja direita'], ['Param107', 'Comprimento da franja esquerda'],
    ['Param102', 'Mecha lateral esquerda', 'choice'], ['Param268', 'Mecha lateral direita', 'choice'],
    ['Param100', 'Comprimento lateral esquerdo'], ['Param101', 'Comprimento lateral direito'],
    ['Param136', 'Largura lateral esquerda'], ['Param135', 'Largura lateral direita'],
    ['Param209', 'Mecha arrepiada esquerda'], ['Param211', 'Mecha arrepiada direita'],
    ['Param210', 'Posição da mecha arrepiada esquerda'], ['Param212', 'Posição da mecha arrepiada direita'],
    ['Param19', 'Mecha do topo', 'choice'], ['Param117', 'Cabelo traseiro', 'choice'],
    ['Param118', 'Comprimento traseiro externo'], ['Param127', 'Comprimento traseiro interno'],
    ['Param132', 'Formato do cabelo traseiro'],
    ['Param131', 'Trança esquerda', 'choice'], ['Param134', 'Trança direita', 'choice'],
    ['Param166', 'Posição da trança esquerda'], ['Param133', 'Posição da trança direita'],
    ['Param167', 'Comprimento da trança esquerda'], ['Param165', 'Comprimento da trança direita'],
    ['Param194', 'Mechas coloridas', 'choice'],
  ]],
  ['clothes', 'Roupas', [
    ['Param307', 'Roupa', 'choice'], ['Param308', 'Acessório de pescoço', 'choice'],
    ['Param325', 'Acessório nas costas', 'choice'], ['Param137', 'Variação da roupa'],
    ['Param157', 'Comprimento da saia'], ['Param192', 'Variação do short'],
    ['Param50', 'Emblema', 'choice'], ['Param280', 'Crachá'],
    ['Param319', 'Posição horizontal do emblema'], ['Param320', 'Posição vertical do emblema'],
  ]],
  ['face', 'Rosto e pele', [
    ['Param352', 'Tom de pele'], ['Param138', 'Largura do rosto'], ['Param139', 'Posição do queixo'],
    ['Param2', 'Formato da boca', 'choice'], ['Param96', 'Posição da boca'], ['Param97', 'Largura da boca'],
    ['Param6', 'Formato do nariz', 'choice'], ['Param87', 'Posição do nariz'], ['Param71', 'Dentes', 'choice'],
    ['Param57', 'Estilo das sobrancelhas', 'choice'], ['Param69', 'Rotação das sobrancelhas'],
    ['Param81', 'Posição das sobrancelhas'],
    ['Param147', 'Sardas'], ['Param74', 'Blush', 'choice'], ['Param187', 'Posição do blush'],
    ['Param72', 'Pinta 1'], ['Param141', 'Pinta 1 — horizontal'], ['Param142', 'Pinta 1 — vertical'],
    ['Param144', 'Pinta 2'], ['Param145', 'Pinta 2 — horizontal'], ['Param146', 'Pinta 2 — vertical'],
    ['Param73', 'Decoração facial', 'choice'], ['Param205', 'Decoração facial extra', 'choice'],
  ]],
  ['eyes', 'Olhos', [
    ['Param56', 'Tamanho dos olhos'], ['Param86', 'Posição dos olhos'], ['Param155', 'Largura dos olhos'],
    ['Param41', 'Cílios', 'choice'], ['Param49', 'Pálpebra inferior', 'choice'], ['Param304', 'Pupilas pequenas'],
    ['Param36', 'Pupila esquerda', 'choice'], ['Param38', 'Pupila direita', 'choice'],
    ['Param42', 'Branco do olho esquerdo', 'choice'], ['Param43', 'Branco do olho direito', 'choice'],
    ['Param7', 'Olho esquerdo escuro'], ['Param8', 'Olho direito escuro'],
    ['Param55', 'Brilho esquerdo', 'choice'], ['Param178', 'Brilho direito', 'choice'],
    ['Param189', 'Posição do brilho esquerdo'], ['Param188', 'Posição do brilho direito'],
  ]],
  ['accessories', 'Acessórios', [
    ['Param148', 'Presilha esquerda', 'choice'], ['Param149', 'Presilha direita', 'choice'],
    ['Param9', 'Enfeite de cabelo esquerdo', 'choice'], ['Param27', 'Enfeite de cabelo direito', 'choice'],
    ['Param153', 'Óculos', 'choice'], ['Param154', 'Posição dos óculos'],
    ['Param314', 'Chapéu', 'choice'], ['Param128', 'Enfeite da cabeça', 'choice'],
    ['Param204', 'Enfeite da cabeça extra', 'choice'], ['Param262', 'Enfeite da cabeça adicional', 'choice'],
    ['Param208', 'Enfeite atrás da cabeça', 'choice'],
    ['Param152', 'Chifres', 'choice'], ['Param179', 'Comprimento dos chifres'],
    ['Param', 'Chifres extras', 'choice'], ['Param199', 'Comprimento dos chifres extras'],
    ['Param109', 'Formato das orelhas', 'choice'], ['Param151', 'Orelhas de animal', 'choice'],
    ['Param180', 'Comprimento das orelhas de animal'],
    ['Param181', 'Posição da orelha de animal esquerda'], ['Param182', 'Posição da orelha de animal direita'],
    ['Param130', 'Peças especiais', 'choice'], ['Param196', 'Peças especiais extras', 'choice'],
  ]],
];

export function getAppearanceControls(core) {
  return groups.flatMap(([group, groupLabel, parameters]) => parameters.flatMap(([id, label, type = 'range']) => {
    const index = core.getParameterIndex(id);
    if (index < 0 || index >= core.getParameterCount()) return [];
    return [{
      id, label, group, groupLabel, type,
      min: core.getParameterMinimumValue(index), max: core.getParameterMaximumValue(index),
      default: core.getParameterDefaultValue(index), step: type === 'choice' ? 1 : .01,
    }];
  }));
}

export function normalizeAppearance(parameters, controls) {
  return Object.fromEntries(controls.map(control => {
    const value = parameters?.[control.id];
    let normalized = typeof value === 'number' && Number.isFinite(value) ? value : control.default;
    normalized = Math.max(control.min, Math.min(control.max, normalized));
    if (control.type === 'choice') normalized = Math.round(normalized);
    return [control.id, normalized];
  }));
}

async function readPreset(response, controls) {
  if (!response.ok) throw new Error('Shared appearance unavailable');
  const preset = await response.json();
  if (preset?.version !== 1 || preset.model !== MODEL_VERSION || !preset.parameters ||
      controls.some(control => typeof preset.parameters[control.id] !== 'number' || !Number.isFinite(preset.parameters[control.id]))) {
    throw new Error('Invalid shared appearance');
  }
  return normalizeAppearance(preset.parameters, controls);
}

export async function loadAppearance(controls, request = globalThis.fetch) {
  const response = await request(`${API_BASE}/api/avatar/appearance`, {
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  return readPreset(response, controls);
}

export async function saveAppearance(parameters, controls, request = globalThis.fetch) {
  const normalized = normalizeAppearance(parameters, controls);
  const response = await request(`${API_BASE}/api/avatar/appearance`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, model: MODEL_VERSION, parameters: normalized }),
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  return readPreset(response, controls);
}
