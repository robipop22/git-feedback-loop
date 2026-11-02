import { writeFile } from "node:fs/promises";
import { pcmWorkletSource } from "../dist/browser/pcm-worklet.js";
await writeFile(
  new URL("../dist/browser/pcm-capture.worklet.js", import.meta.url),
  pcmWorkletSource,
);
