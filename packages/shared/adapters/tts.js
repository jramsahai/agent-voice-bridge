import { speakWithMacosSay } from './tts-macos-say.js';
import { speakWithKokoroOnnx } from './tts-kokoro-onnx.js';

export async function speakText(text, ttsConfig = {}) {
  const provider = ttsConfig.provider || 'macos-say';
  if (provider === 'kokoro-onnx') {
    return speakWithKokoroOnnx(text, ttsConfig);
  }
  if (provider === 'macos-say') {
    return speakWithMacosSay(text, ttsConfig);
  }
  throw new Error(`Unsupported TTS provider: ${provider}`);
}
