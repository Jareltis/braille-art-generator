// SPDX-License-Identifier: GPL-3.0-or-later
// Whether the art can still follow the sliders.
//
// This used to be a cell count: below two hundred by two hundred the art
// redrew as you dragged, above it you pressed the button. A count is the wrong
// unit for the question, because the same grid is half a second on a laptop and
// several on a phone, and the number was picked on one machine.
//
// So the answer comes from what the last redraw actually cost, scaled to the
// size being asked for now. Dithering walks every dot once, so cost against
// cell count is close enough to a straight line for this purpose -- and the
// estimate only has to be right about which side of half a second it lands on.

/** Longer than this and the art stops following: the wait stops feeling like a redraw. */
export const LIVE_BUDGET_MS = 400;

/**
 * And it has to come back comfortably under before it follows again.
 *
 * Without the gap, a grid sitting exactly on the line would start and stop
 * following on alternate keystrokes.
 */
export const LIVE_RESUME_MS = 250;

/**
 * Would a redraw of this many cells still keep up?
 *
 * `measured` is what the last redraw cost and how many cells it covered. With
 * nothing measured yet the answer is yes: something has to run before there is
 * anything to judge by, and the first redraw is the one that provides it.
 */
export function keepsUp(cells, measured, following = true) {
  if (!measured || !(measured.cells > 0) || !Number.isFinite(measured.ms)) return true;

  const estimate = measured.ms * (cells / measured.cells);
  return following ? estimate <= LIVE_BUDGET_MS : estimate <= LIVE_RESUME_MS;
}
