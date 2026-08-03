import { speakWithMacosSay } from './tts-macos-say.js';
import { speakWithKokoroFast } from './tts-kokoro-onnx.js';

export async function speakText(text, ttsConfig = {}, { signal } = {}) {
  const provider = ttsConfig.provider || 'macos-say';
  if (provider === 'kokoro-onnx') {
    return speakWithKokoroFast(text, ttsConfig, { signal });
  }
  if (provider === 'macos-say') {
    return speakWithMacosSay(text, ttsConfig, { signal });
  }
  throw new Error(`Unsupported TTS provider: ${provider}`);
}
