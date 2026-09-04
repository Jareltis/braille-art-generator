// SPDX-License-Identifier: GPL-3.0-or-later
// Starting points for the kinds of image people actually bring.
//
// A preset is just a set of control values -- nothing here is a separate code
// path. Each one sets every control it cares about, so picking one twice always
// lands in the same place no matter what was fiddled with in between.
//
// Names and explanations live in the dictionaries, under preset.<key> and
// preset.<key>.hint: this file holds no words anyone reads.

export const CONTENT_PRESETS = Object.freeze({
  photo: {
    settings: {
      method: 'floyd-steinberg',
      threshold: 128,
      edgeMode: 'none',
      edgeAmount: 100,
      edgeRadius: 1,
      brightness: 0,
      contrast: 10,
      saturation: 0,
      sharpness: 0.5,
      smooth: true,
    },
  },

  lineart: {
    settings: {
      method: 'threshold',
      threshold: 40,
      edgeMode: 'xdog',
      edgeAmount: 100,
      edgeRadius: 1,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      sharpness: 0,
      smooth: true,
    },
  },

  logo: {
    settings: {
      method: 'threshold',
      threshold: 128,
      edgeMode: 'none',
      edgeAmount: 100,
      edgeRadius: 1,
      brightness: 0,
      contrast: 45,
      saturation: 0,
      sharpness: 0,
      smooth: true,
    },
  },

  pixel: {
    settings: {
      method: 'threshold',
      threshold: 128,
      edgeMode: 'none',
      edgeAmount: 100,
      edgeRadius: 1,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      sharpness: 0,
      smooth: false,
    },
  },
});
