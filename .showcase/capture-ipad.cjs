"use strict";
// Retained entry point; all assets now share the same renderer and capture setup.
process.env.SHOWCASE_CAPTURE_ONLY = "ipad";
require("./capture.cjs");
