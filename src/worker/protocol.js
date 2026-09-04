// SPDX-License-Identifier: GPL-3.0-or-later
// How pixels cross the worker boundary.
//
// ImageData is sent as its three parts with the buffer transferred rather than
// cloned: at 900x700 a copy is ~2.5 MB, and a live pipeline moves one every
// frame in each direction.
//
// Transferring detaches the sender's buffer, so whatever is handed to these
// helpers must not be read again afterwards.

export const pack = (imageData) => ({
  data: imageData.data,
  width: imageData.width,
  height: imageData.height,
});

export const unpack = ({ data, width, height }) => new ImageData(data, width, height);

export const transferOf = (packed) => [packed.data.buffer];
