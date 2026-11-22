// O backend só libera eventos da assistente após validar voz + expressão;
// falhas no turno não podem deixar respostas órfãs no histórico.
export class LiveConversation {
  constructor({ append, update, remove = () => {}, onStatus, onWaiting = () => {}, waitMs = 75000 }) {
    Object.assign(this, { append, update, remove, onStatus, onWaiting, waitMs });
    this.turns = new Map(); this.turnId = 1;
  }
  turn(id) {
    if (!this.turns.has(id)) {
      this.turns.set(id, { local: [], response: false });
      if (this.turns.size > 256) {
        const oldest = this.turns.keys().next().value;
        clearTimeout(this.turns.get(oldest).timer); this.turns.delete(oldest);
      }
    }
    return this.turns.get(id);
  }
  wait(id, message = 'Pergunta enviada. Preparando voz e expressão Live…') {
    const turn = this.turn(id);
    if (turn.closed || turn.failed || turn.response) return;
    clearTimeout(turn.timer); turn.waiting = true; turn.response = false;
    this.onWaiting(true, message);
    this.onStatus(message);
    turn.timer = setTimeout(() => {
      turn.timer = null;
      if (!turn.waiting || turn.response || turn.closed) return;
      this.onStatus('O Live ainda está preparando voz e expressão. Aguarde ou encerre a conversa.');
    }, this.waitMs);
  }
  waiting({ turn_id: id, message }) {
    this.wait(id, typeof message === 'string' && message.trim()
      ? message : 'Preparando voz e expressão Live. Aguarde…');
  }
  sendText(text, send) {
    send({ type: 'text', text }); // Envia antes de atualizar a UI para preservar o texto se o socket recusar.
    const turn = this.turn(this.turnId);
    turn.local.push(text);
    this.append('user', text);
    this.wait(this.turnId);
  }
  response(id, message) {
    const turn = this.turn(id);
    turn.response = true; turn.waiting = false;
    clearTimeout(turn.timer); turn.timer = null;
    this.onWaiting(false); this.onStatus(message);
  }
  transcript({ role, text, turn_id: id }) {
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text) return;
    const turn = this.turn(id);
    if (turn.interrupted || (role === 'assistant' && turn.failed)) return;
    const caption = turn[role] ||= { text: '' };
    caption.text += text;
    // Evita duplicar a mensagem digitada caso o Gemini ecoe a entrada do usuário.
    const localEcho = role === 'user' && turn.local.some(local => local.startsWith(caption.text));
    if (!localEcho) {
      if (caption.article) this.update(caption.article, caption.text);
      else caption.article = this.append(role, caption.text);
    }
    if (role === 'assistant') this.response(id, 'Resposta Live recebida com voz e expressão.');
    else if (!turn.response && !turn.closed) this.wait(id);
  }
  audio(id) { if (!this.turn(id).failed) this.response(id, 'Recebendo áudio Live.'); }
  warning({ turn_id: id, message }) {
    if (typeof message !== 'string' || !message.trim()) return;
    const turn = this.turn(id);
    clearTimeout(turn.timer); turn.timer = null;
    turn.failed = true; turn.response = false;
    if (turn.assistant?.article) this.remove(turn.assistant.article);
    delete turn.assistant;
    if (turn.warning !== message) this.append('error', message);
    turn.warning = message; turn.warned = true; turn.waiting = false;
    this.onWaiting(false); this.onStatus(message);
  }
  complete(id, interrupted = false) {
    const turn = this.turn(id);
    clearTimeout(turn.timer); turn.timer = null;
    turn.closed = true; turn.interrupted = interrupted;
    this.onWaiting(false);
    if (interrupted) this.onStatus('Resposta Live interrompida. Você pode continuar falando ou enviar texto.');
    else if (turn.warning && !turn.response) this.onStatus(turn.warning);
    else if ((turn.waiting || turn.warned) && !turn.response) {
      const message = 'O Live encerrou este turno sem enviar uma resposta. Tente novamente.';
      if (!turn.warned) { this.onStatus(message); this.append('error', message); }
    } else this.onStatus('Turno Live recebido. Você pode continuar falando ou enviar texto.');
    turn.waiting = false;
    if (Number.isFinite(id)) this.turnId = Math.max(this.turnId, id + 1);
  }
  error(message) { this.onStatus(message); this.append('error', message); }
  reset() {
    for (const turn of this.turns.values()) clearTimeout(turn.timer);
    this.turns.clear(); this.turnId = 1;
  }
}
