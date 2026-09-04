// SPDX-License-Identifier: GPL-3.0-or-later
// The webcam as a source.
//
// A captured frame is drawn to a canvas and handed on like any other picture,
// so nothing downstream learns where it came from.

/** Kept modest: the encoder samples the original, and a 4K stream buys nothing. */
const WANTED = { width: { ideal: 1280 }, height: { ideal: 720 } };

export function createCamera(video) {
  let stream = null;

  return {
    isRunning: () => stream !== null,

    /**
     * Ask for the camera. Rejects with something worth showing: refusing
     * permission, having no camera and being on an insecure origin are all
     * ordinary situations, not faults.
     */
    async start() {
      if (stream) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Камера недоступна: нужен https или localhost.');
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: WANTED, audio: false });
      } catch (error) {
        const reason = error?.name === 'NotAllowedError' ? 'доступ к камере не разрешён'
          : error?.name === 'NotFoundError' ? 'камера не найдена'
            : error?.message || 'не удалось открыть камеру';
        throw new Error(`Камера: ${reason}.`);
      }
      video.srcObject = stream;
      await video.play();
    },

    stop() {
      if (!stream) return;
      for (const track of stream.getTracks()) track.stop();
      stream = null;
      video.srcObject = null;
    },

    /** The current frame, at the size the camera is actually delivering. */
    capture(createCanvas) {
      if (!stream || !video.videoWidth) return null;
      const frame = createCanvas(video.videoWidth, video.videoHeight);
      frame.getContext('2d').drawImage(video, 0, 0);
      return frame;
    },
  };
}
