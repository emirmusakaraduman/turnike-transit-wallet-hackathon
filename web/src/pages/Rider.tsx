import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { turnikeAbi } from "../lib/abi";
import { monadTestnet } from "../lib/chain";
import { publicClient, walletFor } from "../lib/clients";
import {
  CITIES,
  TARIFFS,
  TURNIKE_ADDRESS,
  centsFromMon,
  cityColor,
  cityName,
  estimateFare,
  lira,
  maxFareMon,
  stationName,
  zoneOf,
} from "../lib/config";
import { syncHistory } from "../lib/history";
import { connectInjected, injected } from "../lib/injected";
import { useLang } from "../lib/i18n";
import { MOCK, mockDeposit, mockRead, mockTap, mockWithdraw } from "../lib/mock";
import { verifyToken, type QrCheck } from "../lib/qr";
import { useRate } from "../lib/rate";
import { RelayError, cardTopUp, knownReason, relayTx } from "../lib/relay";
import type { Hist } from "../lib/types";
import { Roundel, Route } from "../lib/ui";
import { getExt, loadPk, setExt } from "../lib/wallet";
import FareCalc from "../components/FareCalc";
import LangSwitch from "../components/LangSwitch";
import Scanner from "../components/Scanner";
import Success, { type Done } from "../components/Success";
import WalletBackup from "../components/WalletBackup";

const MIN_DEPOSIT = parseEther("0.08");
const ETH_BLOCK_MS = 12_000;
const AMOUNTS = ["0.05", "0.1", "0.25", "0.5"];
const CARD_MAX = 0.25;
const WELCOME_MON = "0.1";

// An injected wallet (MetaMask, Rabby, ...) is used only to add balance, so taps never need a popup.

type Trip = { op: number; st: number; at: number; transfer: boolean };
type Last = {
  kind: "tapIn" | "tapOut" | "penalty";
  ms: number;
  fare?: number;
  hash?: string;
  op: number;
  station: number;
  from?: number;
  at: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mon = (v: bigint | number, d = 4) => (typeof v === "bigint" ? Number(formatEther(v)) : v).toFixed(d);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const hms = (ms: number) => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const errText = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 180);
const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export default function Rider() {
  const { t, lang } = useLang();
  const rate = useRate();
  const pk = useMemo(loadPk, []);
  const account = useMemo(() => privateKeyToAccount(pk), [pk]);
  const wallet = useMemo(() => walletFor(pk), [pk]);

  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const op = Number(q.get("op") ?? 0);
  const st = Number(q.get("st") ?? 0);
  const tok = q.get("t");
  const hasStation = CITIES.some((c) => c.id === op && c.stations.some((s) => s.id === st));

  const [deposit, setDeposit] = useState<bigint>(0n);
  const [native, setNative] = useState<bigint>(0n);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [lastTrip, setLastTrip] = useState<{ op: number; at: number } | null>(null);
  const [stage, setStage] = useState(0); // 0 wallet, 1 balance, 4 ready
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState("");
  const [last, setLast] = useState<Last | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [hist, setHist] = useState<Hist[]>([]);
  const [now, setNow] = useState(Date.now());
  const [scanning, setScanning] = useState(false);
  const [qr, setQr] = useState<QrCheck | "checking" | null>(null);
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState("0.1");
  const [ext, setExtState] = useState<Address | undefined>(getExt());

  const ready = stage === 4;
  const need = hasStation ? maxFareMon(op, rate) : 0;
  const depositNum = parseFloat(mon(deposit));
  const lowBal = hasStation && !trip && ready && depositNum + 1e-9 < need;
  const wrongCity = !!trip && hasStation && trip.op !== op;
  const estMon = trip && hasStation && !wrongCity ? estimateFare(op, trip.st, st, { transfer: trip.transfer, rate }) : null;
  const penAmt = trip ? maxFareMon(trip.op, rate) : 0;
  const canPenalty = !!trip && hasStation && depositNum >= penAmt + need - 1e-9;
  const fiat = (m: number) => lira(centsFromMon(m, rate), lang);
  const withdrawTarget = ext ?? account.address;
  const transferEligible =
    hasStation && !trip && !!lastTrip && lastTrip.op === op && TARIFFS[op].transferSec > 0 && (now - lastTrip.at) / 1000 <= TARIFFS[op].transferSec;

  const friendly = useCallback(
    (e: unknown) => {
      const m = String((e as Error)?.message ?? e);
      const k = knownReason(m);
      if (k) return t(k);
      if ((e as { code?: number }).code === 4001 || /user rejected|user denied|rejected the request/i.test(m)) return t("walletRejected");
      return errText(e);
    },
    [t],
  );

  const refresh = useCallback(async () => {
    if (MOCK) {
      const m = mockRead(account.address);
      const d = parseEther(m.deposit.toFixed(4));
      setDeposit(d);
      setNative(0n);
      setTrip(m.trip ? { op: m.trip.op, st: m.trip.st, at: m.trip.at, transfer: !!m.trip.transfer } : null);
      setLastTrip(m.last);
      setHist(m.hist);
      return d;
    }
    const [d, n, tr] = await Promise.all([
      publicClient.readContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "balances", args: [account.address] }),
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "trips", args: [account.address] }),
    ]);
    setDeposit(d);
    setNative(n);
    setTrip(tr[4] ? { op: tr[0], st: tr[1], at: Number(tr[3]) * 1000, transfer: tr[5] } : null);
    setLastTrip(tr[7] > 0n ? { op: tr[6], at: Number(tr[7]) * 1000 } : null);
    return d;
  }, [account.address]);

  /** Re-reads the balance until it shows `above` (a freshly confirmed top-up can take a block to be visible). */
  const refreshUntil = useCallback(
    async (above: bigint) => {
      for (let i = 0; i < 8; i++) {
        if ((await refresh()) > above) return;
        await sleep(400);
      }
    },
    [refresh],
  );

  const loadHist = useCallback(async () => {
    if (MOCK) return;
    try {
      setHist(await syncHistory(account.address));
    } catch {
      /* history is best-effort */
    }
  }, [account.address]);

  const prepare = useCallback(async () => {
    setErr("");
    try {
      const flag = `turnike.init.${account.address}`;
      if (MOCK) {
        if (!localStorage.getItem(flag)) {
          mockDeposit(account.address);
          localStorage.setItem(flag, "1");
        }
        await refresh();
        setStage(4);
        return;
      }
      // First run only: a welcome credit through the (simulated) card top-up. Later changes are the rider's choice.
      const d = await refresh();
      if (d < MIN_DEPOSIT && !localStorage.getItem(flag)) {
        setStage(1);
        localStorage.setItem(flag, "1"); // mark first so a reload during the request cannot credit twice
        try {
          await cardTopUp(account.address, WELCOME_MON);
        } catch (e) {
          localStorage.removeItem(flag);
          throw e;
        }
        await refreshUntil(d);
      }
      setStage(4);
      void loadHist();
    } catch (e) {
      setErr(friendly(e));
    }
  }, [account.address, friendly, loadHist, refresh, refreshUntil]);

  // once per page load (prepare changes identity on every render because it depends on the translator)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void prepare();
  }, [prepare]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // verify the rotating-QR token that came with the scanned link
  useEffect(() => {
    if (!hasStation || tok === null) {
      setQr(null);
      return;
    }
    setQr("checking");
    void verifyToken(op, st, tok).then(setQr);
  }, [op, st, tok, hasStation]);

  const tap = async (force = false) => {
    setBusy(true);
    setErr("");
    const was = trip;
    try {
      const chk = tok !== null || !MOCK ? await verifyToken(op, st, tok) : { ok: true };
      if (!chk.ok) {
        setQr(chk);
        throw new Error(chk.reason === "expired" ? t("qrExpired") : t("qrInvalid"));
      }
      let res: Pick<Last, "kind" | "ms" | "fare" | "hash">;
      if (MOCK) {
        const r = await mockTap(account.address, op, st, force);
        res = { kind: r.kind, ms: r.ms, fare: r.fare };
      } else {
        const action = was && !force ? "tapOut" : "tapIn";
        const t0 = performance.now();
        let hash: Hex;
        try {
          // gas is paid by the sponsor wallet: the rider only signs (instant, no popup)
          hash = await relayTx(account, { action, op, station: st });
        } catch (e) {
          // sponsor unavailable (not a contract revert): send it ourselves if this wallet happens to hold MON
          if (e instanceof RelayError && e.infra && native >= parseEther("0.02")) {
            hash = await wallet.writeContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: action, args: [op, st] });
          } else {
            throw e;
          }
        }
        const rc = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
        const ms = Math.round(performance.now() - t0);
        const out = parseEventLogs({ abi: turnikeAbi, logs: rc.logs, eventName: "TapOut" })[0];
        const pen = parseEventLogs({ abi: turnikeAbi, logs: rc.logs, eventName: "Penalty" })[0];
        res = pen
          ? { kind: "penalty", ms, hash, fare: Number(formatEther(pen.args.fare)) }
          : out
            ? { kind: "tapOut", ms, hash, fare: Number(formatEther(out.args.fare)) }
            : { kind: "tapIn", ms, hash };
      }
      setLast({ ...res, op, station: st, from: was && !force ? was.st : undefined, at: Date.now() });
      setDone({ ...res, station: stationName(op, st), city: cityName(op) });
      await refresh();
      if (!MOCK) setTimeout(() => void loadHist(), 1500);
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  /** Adds balance with a simulated card payment (nothing is charged). */
  const cardTop = async (amt: string) => {
    setWorking(true);
    setErr("");
    try {
      const before = deposit;
      if (MOCK) {
        mockDeposit(account.address, Number(amt));
        await refresh();
      } else {
        await cardTopUp(account.address, amt);
        await refreshUntil(before);
      }
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setWorking(false);
    }
  };

  /** Adds balance from the rider's own wallet extension: depositFor(app wallet), the extension pays the gas. */
  const fundFromWallet = async () => {
    if (!injected()) {
      setErr(t("noExtension"));
      return;
    }
    setWorking(true);
    setErr("");
    try {
      const { from, client: extClient } = await connectInjected();
      const before = deposit;
      const hash = await extClient.writeContract({
        address: TURNIKE_ADDRESS,
        abi: turnikeAbi,
        functionName: "depositFor",
        args: [account.address],
        value: parseEther(amount),
        account: from,
        chain: monadTestnet,
      });
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      setExt(from);
      setExtState(from);
      try {
        localStorage.setItem(`turnike.init.${account.address}`, "1");
      } catch {
        /* ignore */
      }
      setStage(4);
      await refreshUntil(before);
      void loadHist();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setWorking(false);
    }
  };

  /** Sends the whole balance to the connected wallet (or the app wallet if none), gas sponsored. */
  const withdraw = async () => {
    setWorking(true);
    setErr("");
    try {
      if (MOCK) {
        mockWithdraw(account.address);
      } else {
        let hash: Hex;
        try {
          hash = await relayTx(account, { action: "withdraw", amount: deposit, to: withdrawTarget });
        } catch (e) {
          if (e instanceof RelayError && e.infra && native >= parseEther("0.02")) {
            // the node estimates ~1M gas for a withdraw (it sends MON out) and Monad charges the gas LIMIT: use a tight one
            hash = await wallet.writeContract({ address: TURNIKE_ADDRESS, abi: turnikeAbi, functionName: "withdrawTo", args: [deposit, withdrawTarget], gas: 100_000n });
          } else {
            throw e;
          }
        }
        await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      }
      await refresh();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setWorking(false);
    }
  };

  const onScan = useCallback((text: string) => {
    const i = text.indexOf("#/rider");
    if (i >= 0) {
      window.location.hash = text.slice(i);
      setLast(null);
      setScanning(false);
    }
  }, []);

  const go = (o: number, s: number) => {
    window.location.hash = `#/rider?op=${o}&st=${s}`;
    setLast(null);
  };

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const closeDone = useCallback(() => setDone(null), []);

  const label = !ready
    ? t("ctaPreparing")
    : busy
      ? t("ctaBusy")
      : !hasStation
        ? t("ctaNeedQr")
        : wrongCity
          ? t("ctaCloseTrip")
          : lowBal
            ? t("ctaLow")
            : trip
              ? t("ctaOut")
              : t("ctaIn");

  const lineColor = hasStation ? cityColor(op) : "#5B6987";
  const tripColor = trip ? cityColor(trip.op) : lineColor;
  const hint = wrongCity ? t("hintOther", { city: cityName(trip!.op) }) : trip ? t("hintOpen") : t("hintIdle");

  // chips shown while preparing
  const chip = (text: string, state: "done" | "run" | "todo") => (
    <span className={`chip ${state}`} key={text}>
      <span className="chip-dot">{state === "done" ? "✓" : state === "run" ? <i className="spin" /> : ""}</span>
      {text}
    </span>
  );

  return (
    <div className="rider-page">
      <header className="topbar">
        <div className="brand">
          <Roundel size={34} />
          <span>Turnike</span>
        </div>
        <div className="bar-r">
          <span className="pill">
            <i className="dot-ok" />
            {MOCK ? t("demoMode") : t("liveTestnet")}
          </span>
          <LangSwitch />
        </div>
      </header>

      <main className="rider">
        {!ready && (
          <div className="prep">
            <div className="chips-row">
              {chip(t("chipWallet"), stage >= 1 ? "done" : err ? "todo" : "run")}
              {chip(t("chipBalance"), stage >= 4 ? "done" : stage >= 1 && !err ? "run" : "todo")}
              {chip(t("chipReady"), "todo")}
            </div>
          </div>
        )}

        {!ready && err && (
          <section className="card warn-card">
            <h2>{t("faucetTitle")}</h2>
            <p>{t("faucetText")}</p>
            {!MOCK && injected() && (
              <button className="ghost" disabled={working} onClick={() => void fundFromWallet()}>
                {working ? t("working") : t("fundFromWallet")}
              </button>
            )}
            <button className="ghost" onClick={() => void prepare()}>
              {t("retryBtn")}
            </button>
          </section>
        )}

        {MOCK && (
          <div className="pick">
            {CITIES.flatMap((c) =>
              c.stations.map((s) => (
                <button key={`${c.id}-${s.id}`} className={c.id === op && s.id === st ? "on" : ""} onClick={() => go(c.id, s.id)}>
                  <i style={{ background: c.color }} />
                  {cityName(c.id)} {s.name}
                </button>
              )),
            )}
          </div>
        )}

        <section className="ticket">
          <div className="band" style={{ background: lineColor }} />
          <div className="ticket-body">
            {hasStation ? (
              <>
                <div className="t-city">{cityName(op)}</div>
                <h1 className="t-station">{stationName(op, st)}</h1>
                <div className="t-zone">{t("zone", { z: zoneOf(op, st) })}</div>
                {trip ? (
                  <Route
                    color={tripColor}
                    from={stationName(trip.op, trip.st)}
                    to={wrongCity ? t("routeUnknown") : stationName(op, st)}
                    fromFilled
                    toFilled={false}
                    dashed={wrongCity}
                  />
                ) : (
                  <Route color={lineColor} from={stationName(op, st)} to={t("routeUnknown")} fromFilled={false} toFilled={false} dashed />
                )}
                {trip && (
                  <div className="tripline">
                    <span>
                      {t("tripTime")} <b className="num">{mmss(now - trip.at)}</b>
                    </span>
                    {estMon !== null && <span className="num">{t("estimated", { x: `${fiat(estMon)} (${estMon.toFixed(3)} MON)` })}</span>}
                  </div>
                )}
                {trip?.transfer && !wrongCity && <div className="okline">{t("transferOn")}</div>}
                {transferEligible && <div className="okline">{t("transferEligible")}</div>}
                <p className="t-hint">{hint}</p>
              </>
            ) : (
              <>
                <div className="t-city">{t("ticketTag")}</div>
                <h1 className="t-station">{t("scanTitle")}</h1>
                <p className="t-hint">{t("scanSub")}</p>
              </>
            )}
            {qr && (
              <div className={`qrb ${qr === "checking" || qr.ok ? "ok" : "bad"}`}>
                {qr === "checking" ? t("qrChecking") : qr.ok ? t("qrVerified") : qr.reason === "expired" ? t("qrExpired") : t("qrInvalid")}
              </div>
            )}
            <button className="ghost small-btn" onClick={() => setScanning(true)}>
              {t("scanBtn")}
            </button>
          </div>

          <div className="perf" aria-hidden>
            <span className="notch l" />
            <span className="notch r" />
          </div>

          <div className="stub">
            <div>
              <div className="s-lbl">{t("balanceLabel")}</div>
              <div className="s-val">
                {mon(deposit, 3)} <small>MON</small>
              </div>
              <div className="s-fiat">{fiat(depositNum)}</div>
            </div>
            {last ? (
              <div className="stamp" key={last.at} style={{ borderColor: cityColor(last.op), color: cityColor(last.op) }}>
                <b>{last.kind === "tapOut" ? t("stampOut") : t("stampIn")}</b>
                <span className="num">{hms(last.at)}</span>
              </div>
            ) : null}
          </div>
        </section>

        {lowBal && (
          <div className="card warn-card inline">
            <p>{t("lowBalance", { x: need.toFixed(3), city: cityName(op) })}</p>
            <button className="ghost small-btn" disabled={working} onClick={() => void cardTop("0.1")}>
              {working ? t("working") : t("topUp")}
            </button>
          </div>
        )}

        {last && (
          <section className="receipt" style={{ borderLeftColor: cityColor(last.op) }}>
            <h2>
              {last.kind === "tapOut"
                ? t("rcOut", { station: stationName(last.op, last.station) })
                : t("rcIn", { station: stationName(last.op, last.station) })}
            </h2>
            {last.kind === "tapOut" && last.from !== undefined && (
              <Route color={cityColor(last.op)} from={stationName(last.op, last.from)} to={stationName(last.op, last.station)} fromFilled toFilled />
            )}
            <div className="hero">
              <span className="hero-n num">{last.ms}</span>
              <span className="hero-u">ms</span>
            </div>
            <div className="caption">{t("rcLatency")}</div>
            <div className="bars">
              <div className="bar">
                <span>Monad</span>
                <div className="tr">
                  <div className="fl ok" style={{ width: `${Math.max(2, (last.ms / ETH_BLOCK_MS) * 100)}%` }} />
                </div>
                <span className="num">
                  {(last.ms / 1000).toFixed(2)} {t("sec")}
                </span>
              </div>
              <div className="bar">
                <span>{t("vsBlock")}</span>
                <div className="tr">
                  <div className="fl bad" style={{ width: "100%" }} />
                </div>
                <span className="num">12.00 {t("sec")}</span>
              </div>
            </div>
            {last.kind !== "tapIn" && last.fare !== undefined && (
              <div className="fare-row">
                <span>{last.kind === "penalty" ? t("penaltyRow") : t("rcFare")}</span>
                <b className="num">
                  {last.kind === "penalty" ? "−" : ""}
                  {fiat(last.fare)}
                  <small> {mon(last.fare, 3)} MON</small>
                </b>
              </div>
            )}
            {last.kind === "penalty" && <p className="pen-note">{t("rcPenaltyNote")}</p>}
            {last.hash && (
              <a className="ext" href={`${monadTestnet.blockExplorers.default.url}/tx/${last.hash}`} target="_blank" rel="noreferrer">
                {t("rcExplorer")}
              </a>
            )}
          </section>
        )}

        <button className={`cta ${busy ? "busy" : ""}`} disabled={!ready || busy || !hasStation || wrongCity || lowBal} onClick={() => void tap(false)}>
          {label}
        </button>

        {trip && hasStation && (
          <button className="ghost danger" disabled={!ready || busy || !canPenalty} onClick={() => void tap(true)}>
            {t("penaltyBtn", { x: penAmt.toFixed(3) })}
          </button>
        )}

        {err && ready && <div className="errcard">{err}</div>}

        {ready && (
          <details className="calc topup">
            <summary>{t("topUpTitle")}</summary>
            <div className="amount-label">{t("amountLabel")}</div>
            <div className="amounts" role="group" aria-label={t("amountLabel")}>
              {AMOUNTS.map((v) => (
                <button key={v} className={amount === v ? "on" : ""} aria-pressed={amount === v} onClick={() => setAmount(v)}>
                  {v}
                </button>
              ))}
            </div>
            <div className="mute small">{fiat(Number(amount))}</div>
            <div className="ghost-row">
              <button className="ghost" disabled={working || busy || Number(amount) > CARD_MAX} onClick={() => void cardTop(amount)}>
                {working ? t("working") : t("payCard")}
              </button>
              {Number(amount) > CARD_MAX && <div className="mute small">{t("cardMax")}</div>}
              {!MOCK && injected() && (
                <button className="ghost" disabled={working || busy} onClick={() => void fundFromWallet()}>
                  {working ? t("working") : t("payWallet")}
                </button>
              )}
            </div>
          </details>
        )}

        {depositNum > 0 && !trip && ready && (
          <button className="ghost" disabled={working || busy} onClick={() => void withdraw()}>
            {working ? t("working") : t("withdrawBtn", { x: mon(deposit, 3), a: shortAddr(withdrawTarget) })}
          </button>
        )}

        <FareCalc defaultOp={hasStation ? op : 1} key={`${lang}-${op}`} />

        <section className="card hist">
          <h3>
            {t("recent")} {!MOCK && <span className="mute">({t("fromChain")})</span>}
          </h3>
          {hist.length === 0 && <div className="mute">{t("recentEmpty")}</div>}
          {hist.slice(0, 6).map((h, i) => (
            <div className="h" key={i} style={{ borderLeftColor: cityColor(h.op) }}>
              <span>
                {h.kind === "penalty"
                  ? `${cityName(h.op)}, ${t("penaltyRow").toLowerCase()}`
                  : `${stationName(h.op, h.from)} → ${stationName(h.op, h.to)}`}
              </span>
              <b className={`num ${h.kind === "penalty" ? "badtxt" : ""}`}>−{mon(h.fare, 3)}</b>
            </div>
          ))}
        </section>

        <WalletBackup />

        <footer className="foot">
          <button className="textbtn" onClick={() => void copyAddr()}>
            {copied ? t("copied") : t("walletAddr", { a: shortAddr(account.address) })}
          </button>
          <div className="foot-links">
            <a href="#/gate">Gate</a>
            <a href="#/operator">{t("opTitle")}</a>
          </div>
        </footer>
      </main>

      {scanning && <Scanner onResult={onScan} onClose={() => setScanning(false)} />}
      {done && <Success done={done} onClose={closeDone} />}
    </div>
  );
}
