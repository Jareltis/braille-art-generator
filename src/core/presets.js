// SPDX-License-Identifier: GPL-3.0-or-later
// Starting points for the kinds of image people actually bring.
//
// A preset is just a set of control values -- nothing here is a separate code
// path. Each one sets every control it cares about, so picking one twice always
// lands in the same place no matter what was fiddled with in between.

export const CONTENT_PRESETS = Object.freeze({
  photo: {
    label: 'Фото и портреты',
    hint: 'Диффузия ошибки передаёт полутона, которых у порога нет',
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
    label: 'Рисунок, аниме, чертёж',
    hint: 'Штрих XDoG вместо яркости; дизеринг выключен, чтобы не зашумлять линию',
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
    label: 'Логотип и текст',
    hint: 'Жёсткий порог и высокий контраст: дизеринг тут только грязнит',
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
    label: 'Пиксель-арт',
    hint: 'Уменьшение без интерполяции — иначе пиксельная сетка размывается в кашу',
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
