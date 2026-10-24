import { useLang } from "../lib/i18n";

export default function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="langsw" role="group" aria-label="Language">
      {(["en", "tr"] as const).map((l) => (
        <button key={l} className={lang === l ? "on" : ""} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
