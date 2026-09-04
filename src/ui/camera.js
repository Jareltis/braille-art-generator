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
        throw Object.assign(new Error('insecure context'), { i18n: 'camera.insecure' });
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: WANTED, audio: false });
      } catch (error) {
        const key = error?.name === 'NotAllowedError' ? 'camera.denied'
          : error?.name === 'NotFoundError' ? 'camera.missing'
            : 'camera.failed';
        throw Object.assign(new Error(error?.message ?? 'camera failed'), { i18n: key });
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
