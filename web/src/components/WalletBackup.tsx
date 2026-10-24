import { useMemo, useState } from "react";
import { useLang } from "../lib/i18n";
import { getBackup, importBackup } from "../lib/wallet";

/** Recovery phrase export and wallet restore: the wallet lives in this browser, so this is its only safety net. */
export default function WalletBackup() {
  const { t } = useLang();
  const backup = useMemo(() => getBackup(), []);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const words = backup.kind === "phrase" ? backup.value.split(" ") : [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(backup.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const download = () => {
    const blob = new Blob([`Turnike wallet backup\n\n${backup.value}\n\nKeep this file private. Anyone who has it controls the wallet.\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "turnike-wallet-backup.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const restore = () => {
    if (!importBackup(input)) {
      setMsg({ ok: false, text: t("restoreBad") });
      return;
    }
    setMsg({ ok: true, text: t("restoreDone") });
    setTimeout(() => window.location.reload(), 900);
  };

  return (
    <details className="calc backup">
      <summary>{t("backupTitle")}</summary>
      <p className="note">{t("backupHelp")}</p>
      {backup.kind === "key" && <p className="note">{t("backupLegacy")}</p>}

      {!shown ? (
        <button className="ghost" onClick={() => setShown(true)}>
          {t("backupShow")}
        </button>
      ) : (
        <>
          {backup.kind === "phrase" ? (
            <ol className="phrase">
              {words.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ol>
          ) : (
            <div className="addr keybox">{backup.value}</div>
          )}
          <div className="ghost-row inline">
            <button className="ghost" onClick={() => void copy()}>
              {copied ? t("copied") : t("backupCopy")}
            </button>
            <button className="ghost" onClick={download}>
              {t("backupDownload")}
            </button>
            <button className="ghost" onClick={() => setShown(false)}>
              {t("backupHide")}
            </button>
          </div>
        </>
      )}

      <h4>{t("restoreTitle")}</h4>
      <p className="note">{t("restoreHelp")}</p>
      <textarea className="restore-input" rows={3} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <button className="ghost" disabled={!input.trim()} onClick={restore}>
        {t("restoreBtn")}
      </button>
      {msg && <div className={msg.ok ? "okline" : "errcard"}>{msg.text}</div>}
    </details>
  );
}
