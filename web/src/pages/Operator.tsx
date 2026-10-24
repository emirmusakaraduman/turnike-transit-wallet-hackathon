import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { formatEther, parseEther, isAddress, type Address, type WalletClient } from "viem";
import { turnikeAbi } from "../lib/abi";
import { publicClient } from "../lib/clients";
import { CITIES, TARIFFS, TURNIKE_ADDRESS, cityName, lira, monFromCents } from "../lib/config";
import { useLang } from "../lib/i18n";
import { connectInjected, injected } from "../lib/injected";
import { MOCK } from "../lib/mock";
import { useRate } from "../lib/rate";
import LangSwitch from "../components/LangSwitch";

type Info = { pending: bigint; payout: string; admin: Address };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errText = (e: unknown) => String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e).split("\n")[0].slice(0, 160);

/** Owner and operator-admin actions: pause, rate, refunds. Signed by a wallet extension that holds the admin key. */
function AdminPanel({ info, rate }: { info: Record<number, Info>; rate: bigint }) {
  const { t } = useLang();
  const [conn, setConn] = useState<{ from: Address; client: WalletClient } | null>(null);
  const [owner, setOwner] = useState<Address>();
  const [paused, setPaused] = useState<boolean>();
  const [rateInput, setRateInput] = useState("");
  const [refOp, setRefOp] = useState(1);
  const [refWho, setRefWho] = useState("");
  const [refAmt, setRefAmt] = useState("0.01");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (MOCK) return;
    const [o, p] = await Promise.all([
      publicClient.readContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "owner" }),
      publicClient.readContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "paused" }),
    ]);
    setOwner(o);
    setPaused(p);
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const run = async (fn: (c: WalletClient, from: Address) => Promise<`0x${string}`>) => {
    setBusy(true);
    setMsg(null);
    try {
      const c = conn ?? (await connectInjected());
      setConn(c);
      const hash = await fn(c.client, c.from);
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      setMsg({ ok: true, text: t("adminDone") });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const write = (c: WalletClient, from: Address, functionName: string, args: unknown[]) =>
    c.writeContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName, args, account: from, chain: c.chain } as never);

  const isOwner = !!conn && !!owner && conn.from.toLowerCase() === owner.toLowerCase();
  const isOpAdmin = !!conn && !!info[refOp] && conn.from.toLowerCase() === info[refOp].admin.toLowerCase();

  return (
    <section className="panel ocard noprint admin">
      <h2>{t("adminTitle")}</h2>
      <p className="mute small">{t("adminNote")}</p>
      {MOCK ? (
        <p className="mute">{t("adminCli")}</p>
      ) : !injected() ? (
        <p className="mute">{t("adminCli")}</p>
      ) : (
        <>
          {conn ? (
            <p className="okline">{t("adminYou", { a: short(conn.from) })}</p>
          ) : (
            <button
              className="ghost"
              disabled={busy}
              onClick={async () => {
                setMsg(null);
                try {
                  setConn(await connectInjected());
                } catch (e) {
                  setMsg({ ok: false, text: errText(e) });
                }
              }}
            >
              {t("adminConnect")}
            </button>
          )}

          <div className="admin-row">
            <span>{paused ? t("pausedNow") : t("runningNow")}</span>
            <button className="ghost" disabled={busy || (!!conn && !isOwner)} onClick={() => void run((c, f) => write(c, f, paused ? "unpause" : "pause", []))}>
              {paused ? t("unpauseBtn") : t("pauseBtn")}
            </button>
          </div>

          <label className="field">
            {t("rateSetLabel")}
            <input value={rateInput} placeholder={rate.toString()} inputMode="numeric" onChange={(e) => setRateInput(e.target.value.replace(/\D/g, ""))} />
          </label>
          <button className="ghost" disabled={busy || !rateInput || (!!conn && !isOwner)} onClick={() => void run((c, f) => write(c, f, "setRate", [BigInt(rateInput)]))}>
            {t("rateSetBtn")}
          </button>

          <h4>{t("refundTitle")}</h4>
          <label className="field">
            {t("tariffTitle")}
            <select value={refOp} onChange={(e) => setRefOp(Number(e.target.value))}>
              {CITIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {cityName(c.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("refundWho")}
            <input value={refWho} placeholder="0x…" onChange={(e) => setRefWho(e.target.value.trim())} />
          </label>
          <label className="field">
            {t("refundAmt")}
            <input value={refAmt} inputMode="decimal" onChange={(e) => setRefAmt(e.target.value)} />
          </label>
          <button
            className="ghost"
            disabled={busy || !isAddress(refWho) || !(Number(refAmt) > 0) || (!!conn && !isOpAdmin)}
            onClick={() => void run((c, f) => write(c, f, "refund", [refOp, refWho, parseEther(refAmt)]))}
          >
            {t("refundBtn")}
          </button>
        </>
      )}
      {msg && <div className={msg.ok ? "okline" : "errcard"}>{msg.text}</div>}
    </section>
  );
}

export default function Operator() {
  const { t, lang } = useLang();
  const rate = useRate();
  const [info, setInfo] = useState<Record<number, Info>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (MOCK) return;
    const out: Record<number, Info> = {};
    for (const c of CITIES) {
      const [pending, o] = await Promise.all([
        publicClient.readContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "pending", args: [c.id] }),
        publicClient.readContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "operators", args: [c.id] }),
      ]);
      out[c.id] = { pending, payout: o[1], admin: o[0] };
    }
    setInfo(out);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
    const id = setInterval(() => void load().catch(() => undefined), 2500);
    return () => clearInterval(id);
  }, [load]);

  const claim = async (op: number) => {
    setBusy(op);
    setMsg("");
    try {
      // claim is permissionless and always pays the operator's own payout address, so the sponsor wallet pays the gas
      const r = await fetch("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `claim ${r.status}`);
      setMsg(`${t("claimed")}, ${cityName(op)}`);
      await load();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const base = `${window.location.origin}${window.location.pathname}`;

  return (
    <div className="opage">
      <div className="top noprint">
        <div className="logo"><i>T</i>Turnike, {t("opTitle")}</div>
        <div className="top-r">
          <a className="navl" href="#/rider">{t("backToRider")}</a>
          <a className="navl" href="#/gate">{t("openGate")}</a>
          <LangSwitch />
        </div>
      </div>
      <p className="mute noprint">{t("opSub")}</p>
      <p className="mute small noprint">{t("rateInfo", { x: monFromCents(100, rate).toFixed(4) })}</p>

      <div className="ogrid noprint">
        {CITIES.map((c) => {
          const tf = TARIFFS[c.id];
          const inf = info[c.id];
          return (
            <div className="panel ocard" key={c.id}>
              <h2>
                <span className="dot" style={{ background: c.color, display: "inline-block", marginRight: 10 }} />
                {cityName(c.id)}
              </h2>
              <div className="mute small">{t("pendingLabel")}</div>
              <div className="big num">
                {MOCK ? "—" : inf ? Number(formatEther(inf.pending)).toFixed(4) : "…"} <small>{t("mon")}</small>
              </div>
              <button className="cta slim" disabled={MOCK || busy !== null || !inf || inf.pending === 0n} onClick={() => void claim(c.id)}>
                {busy === c.id ? t("working") : t("claimBtn")}
              </button>
              {inf && <div className="mute small addr-l">{t("payoutAddr")}: {inf.payout}</div>}

              <h4>{t("tariffTitle")}</h4>
              <table>
                <tbody>
                  <tr><td>{t("baseFare")}</td><td className="num">{lira(tf.base, lang)}</td></tr>
                  <tr><td>{t("perZone")}</td><td className="num">{lira(tf.per, lang)}</td></tr>
                  <tr><td>{t("maxFare")}</td><td className="num">{lira(tf.max, lang)}, {monFromCents(tf.max, rate).toFixed(3)} MON</td></tr>
                  <tr><td>{t("dailyCapLabel")}</td><td className="num">{lira(tf.cap, lang)}</td></tr>
                  <tr><td>{t("transferLabel")}</td><td className="num">{tf.transferSec / 60} {t("minutesUnit")}</td></tr>
                </tbody>
              </table>

              <h4>{t("stationsTitle")}</h4>
              <table>
                <tbody>
                  {c.stations.map((s) => (
                    <tr key={s.id}><td>{s.name}</td><td className="num">{t("zone", { z: s.zone })}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      {msg && <div className="mute noprint">{msg}</div>}
      <div className="mute small noprint">{t("needGas")}</div>

      <AdminPanel info={info} rate={rate} />

      <button className="seg noprint" onClick={() => window.print()}>{t("printQr")}</button>

      <div className="sheet">
        {CITIES.flatMap((c) =>
          c.stations.map((s) => (
            <div className="sheet-qr" key={`${c.id}-${s.id}`}>
              <QRCodeSVG value={`${base}#/rider?op=${c.id}&st=${s.id}`} size={200} />
              <b>{cityName(c.id)}, {s.name}</b>
              <small>{t("zone", { z: s.zone })}</small>
            </div>
          )),
        )}
      </div>
    </div>
  );
}
