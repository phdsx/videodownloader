import { remuxMp4 } from "./mp4-mux.js";

self.onmessage = async ({ data: { video, audio } }) => {
  try {
    const blob = await remuxMp4(video, audio);
    self.postMessage({ blob });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
