// Reduz a respiração durante animações expressivas em vez de congelar a cabeça.
export function headBreathTarget({ tracking, reducedMotion, expressing }) {
  return tracking || reducedMotion ? 0 : expressing ? .35 : 1;
}

// Movimento sutil centrado em zero para poses absolutas estáticas que substituem a base
// automática do Cubism, sem alterar parâmetros faciais nem gestos com movimento próprio.
export function secondaryMotion(seconds, { tracking = false, reducedMotion = false } = {}) {
  if (reducedMotion) return {};
  return {
    ...(!tracking && {
      ParamAngleX: Math.sin(seconds * .9) * .65,
      ParamAngleY: Math.sin(seconds * 1.2) * .45,
      ParamAngleZ: Math.sin(seconds * 1.4) * .5,
    }),
    ParamBodyAngleX: Math.sin(seconds * .8) * .3,
    ParamBodyAngleY: Math.sin(seconds * 1.1) * .2,
    ParamBodyAngleZ: Math.sin(seconds * .7) * .25,
  };
}
