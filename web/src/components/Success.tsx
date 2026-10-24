import { useEffect } from "react";
import { useLang } from "../lib/i18n";

export type Done = { kind: "tapIn" | "tapOut" | "penalty"; ms: number; fare?: number; station: string; city: string };

function beep(ok: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const seq = ok ? [660, 880] : [220, 180];
    seq.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.start(t);
      o.stop(t + 0.12);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* audio is optional */
  }
}

/** Full-screen "gate open" confirmation: turnstile animation, haptics, sound, confirmation latency. */
export default function Success({ done, onClose }: { done: Done; onClose: () => void }) {
  const { t } = useLang();
  const pen = done.kind === "penalty";

  useEffect(() => {
    try {
      navigator.vibrate?.(pen ? [200, 80, 200] : [60, 40, 60]);
    } catch {
      /* ignore */
    }
    beep(!pen);
    const id = setTimeout(onClose, pen ? 6000 : 4200);
    return () => clearTimeout(id);
  }, [pen, onClose]);

  const title = pen ? t("penaltyTitle") : done.kind === "tapIn" ? t("gateOpen") : t("safeTrip");

  return (
    <div className={`success ${pen ? "pen" : ""}`} onClick={onClose} role="dialog">
      <div className="gatefx" aria-hidden>
        <span className="post l" />
        <span className="post r" />
        <span className="arm" />
        <span className="tick">{pen ? "!" : "✓"}</span>
      </div>
      <div className="s-title">{title}</div>
      <div className="s-sub">
        {pen ? t("penaltySub") : done.kind === "tapIn" ? t("welcomeIn") : `${done.city} · ${done.station}`}
      </div>
      <div className="s-ms num">
        {done.ms}
        <small>ms</small>
      </div>
      <div className="s-sub">{t("confirmedIn")}</div>
      {done.kind !== "tapIn" && done.fare !== undefined && (
        <div className="s-fare num">
          {pen ? t("penaltyCharged") : t("fareCharged")}: {done.fare.toFixed(3)} {t("mon")}
        </div>
      )}
    </div>
  );
}
