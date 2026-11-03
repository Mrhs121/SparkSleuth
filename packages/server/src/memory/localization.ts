/** Language preferences apply only when generating new content, never when reading saved memory. */
export type GenerationLanguage = 'zh' | 'en';
export const languageBodySchema = { type: 'object', properties: { language: { enum: ['zh', 'en'] } } };

export function generationLanguage(language?: GenerationLanguage): string {
  return language ? `\nWrite all model-authored titles, descriptions, lessons and Markdown prose in ${language === 'zh' ? 'Simplified Chinese (简体中文)' : 'English'}, regardless of the language of source notes or examples. Preserve code, rule IDs, technical identifiers, quoted evidence and numeric facts exactly; do not invent or change evidence. Translate section headings, not JSON keys or technical tags.` : '\nFollow the language of the latest user turn in the transcript/source notes.';
}
