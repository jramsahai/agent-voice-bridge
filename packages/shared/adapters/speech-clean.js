// Turns an agent's written reply into text a speech synthesizer can read aloud without
// narrating markdown. Agent-independent: every adapter's `text` field passes through here,
// while `rawText` keeps the reply verbatim for clients that display it.

export function cleanTextForSpeech(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^-+\s+/gm, ' ')
    .replace(/^\d+\.\s+/gm, ' ')
    .replace(/^\[\s*[xX]\s*\]\s+/gm, ' ')
    .replace(/^\[\s*\]\s+/gm, ' ')
    // Extended_Pictographic/Emoji_Presentation/Emoji_Modifier/Regional_Indicator plus the
    // ZWJ, VS16, and keycap enclosing mark cover multi-code-point emoji sequences; the
    // legacy arrow/bullet/checkmark set stays explicit since none of it is caught by those
    // properties (✓ U+2713 notably is not Extended_Pictographic).
    .replace(/[→\-•✓✔\u200D\uFE0F\u20E3\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu, ' ')
    .replace(/:\s*$/gm, ' ')
    .replace(/:\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
