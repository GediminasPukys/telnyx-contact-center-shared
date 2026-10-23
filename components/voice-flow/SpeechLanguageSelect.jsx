"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { SONIOX_TTS_LANGUAGES } from "@/config/voice";
import { getLanguageByCode } from "@/lib/languages";

const DEFAULT_LANGUAGE = "__default__";

/**
 * Pronunciation language for multilingual TTS voices (Soniox). Stored as the
 * top-level `language` of speak / gather_using_speak; omitted means the
 * provider default (English).
 */
export function SpeechLanguageSelect({ config = {}, onChange, disabled }) {
  const tUi = useUiText();

  const options = useMemo(
    () => [
      { value: DEFAULT_LANGUAGE, label: tUi("Provider default (English)") },
      ...SONIOX_TTS_LANGUAGES.map((code) => {
        const language = getLanguageByCode(code);
        return { value: code, label: `${language.flag} ${language.name} (${code})` };
      }),
    ],
    [tUi],
  );

  const handleChange = (value) => {
    const nextConfig = { ...config };
    if (!value || value === DEFAULT_LANGUAGE) {
      delete nextConfig.language;
    } else {
      nextConfig.language = value;
    }
    onChange?.(nextConfig);
  };

  return (
    <div>
      <Label>{tUi("Speech Language")}</Label>
      <Combobox
        value={config.language || DEFAULT_LANGUAGE}
        onChange={handleChange}
        options={options}
        placeholder={tUi("Select language")}
        searchPlaceholder={tUi("Search languages...")}
        emptyText={tUi("No languages found")}
        triggerClassName="w-full mt-1"
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground mt-1">{tUi("Soniox voices speak every supported language: the voice sets the accent, this sets the pronunciation.")}</p>
    </div>
  );
}
