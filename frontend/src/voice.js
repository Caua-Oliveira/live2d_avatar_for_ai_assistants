export class VoiceRecorder {
  generation = 0;

  async start(onEnded, onChunk = null) {
    const generation = ++this.generation;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('O microfone precisa de HTTPS ou localhost para funcionar.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      stream.getAudioTracks()[0].addEventListener('ended', onEnded);
      this.context = new AudioContext();
      await this.context.resume();
      await this.context.audioWorklet.addModule('/pcm-recorder.js');
      if (generation !== this.generation) return false;
      this.source = this.context.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.context, 'pcm-recorder');
      this.node.port.onmessage = ({ data }) => {
        if (data === 'stopped') this.onStopped?.();
        else if (onChunk) onChunk(data, this.context.sampleRate);
      };
      this.source.connect(this.node);
      // O worklet emite silêncio para continuar agendado no grafo de áudio sem gerar retorno do microfone.
      this.node.connect(this.context.destination);
      return true;
    } catch (error) {
      if (generation === this.generation) this.cancel();
      throw error;
    }
  }

  async stop() {
    if (!this.node) return;
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 500);
      this.onStopped = () => { clearTimeout(timeout); resolve(); };
      this.node.port.postMessage('stop');
    });
    this.cancel();
  }

  cancel() {
    this.generation++;
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.context?.close().catch(() => {});
    this.context = this.source = this.node = this.stream = null;
    this.onStopped?.();
    this.onStopped = null;
  }
}
