// Inference stays on-device. Only the detector assets are downloaded.
export class FaceTracking {
  stream = null;
  detector = null;
  generation = 0;
  frame = null;

  constructor(video, onGaze, onStatus, onError) {
    Object.assign(this, { video, onGaze, onStatus, onError });
  }

  async start() {
    const generation = ++this.generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('A câmera precisa de HTTPS ou localhost para funcionar.');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (this.stream === stream) { this.stop(); this.onError(new Error('A câmera foi desconectada.')); }
      });
      this.video.srcObject = stream;
      await this.video.play();
      this.onStatus('Preparando o contato visual…');
      if (!this.detector) {
        const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
        const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm');
        const detector = await FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite' },
          runningMode: 'VIDEO', minDetectionConfidence: .55,
        });
        if (generation !== this.generation) { detector.close(); return; }
        this.detector = detector;
      }
      if (generation !== this.generation) return;
      let lastTime = -1;
      let lastDetection = 0;
      let lastFaceSeen = -Infinity;
      const detect = now => {
        if (generation !== this.generation) return;
        if (!document.hidden && now - lastDetection > 100 && this.video.readyState >= 2 && this.video.currentTime !== lastTime) {
          lastTime = this.video.currentTime;
          lastDetection = now;
          try {
            const { detections } = this.detector.detectForVideo(this.video, now);
            // The largest face is the person closest to the assistant.
            const face = detections.sort((a, b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0];
            if (face) {
              lastFaceSeen = now;
              const box = face.boundingBox;
              const x = 1 - 2 * (box.originX + box.width / 2) / this.video.videoWidth;
              const y = 1 - 2 * (box.originY + box.height / 2) / this.video.videoHeight;
              this.onGaze(x, y, true);
              this.onStatus('Contato visual conectado');
            } else if (now - lastFaceSeen > 450) {
              // Brief detector misses during movement should not snap gaze back
              // to idle. A sustained loss still releases the gaze to center.
              this.onGaze(0, 0, false);
              this.onStatus('Procurando seu rosto…');
            }
          } catch (error) { this.stop(); this.onError(error); return; }
        }
        this.frame = requestAnimationFrame(detect);
      };
      this.frame = requestAnimationFrame(detect);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      throw error;
    }
  }

  stop() {
    this.generation++;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.onGaze(0, 0, false);
  }

  destroy() { this.stop(); this.detector?.close(); }
}
