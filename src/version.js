// SPDX-License-Identifier: GPL-3.0-or-later
// What version this is.
//
// One string, in one place, because there were none and that cost something
// real: the offline cache is keyed by a version written into sw.js by hand, and
// it went twenty releases without being touched. Anyone whose browser had
// installed the worker went on being served the shell they first cached.
//
// A test compares this against the string in sw.js, so the two cannot drift
// apart again without the suite saying so.

export const APP_VERSION = '0.37.0';
