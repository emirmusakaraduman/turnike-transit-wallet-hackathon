import { useEffect, useRef, useState, type CSSProperties } from "react";
import { QRCodeSVG } from "qrcode.react";
import { formatEther, parseEventLogs } from "viem";
import { turnikeAbi } from "../lib/abi";
import { publicClient } from "../lib/clients";
import { CITIES, TURNIKE_ADDRESS, cityColor, cityName, stationName, zoneOf } from "../lib/config";
import { useLang } from "../lib/i18n";
import { MOCK, mockCrowdBurst, onMockEvents } from "../lib/mock";
import { mintToken } from "../lib/qr";
import { Roundel } from "../lib/ui";
import LangSwitch from "../components/LangSwitch";

type Item = { key: string; kind: "in" | "out" | "pen"; rider: string; op: number; station: number; fare: number; at: number };
// Normalized event, same shape for chain logs and mock events.
type Ev = { kind: "in" | "out" | "pen"; rider: string; op: number; station: number; from: number; fare: number; block: bigint; key: string };
type Stress = { taps: number; blocks: number; seconds: number; peak: number };

const ETH_BLOCK_MS = 12_000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hms = (ms: number) => new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
// Same shard the contract uses: low 4 bits of the rider address = last hex digit.
const shardOf = (a: string) => parseInt(a.slice(-1), 16);

type Rush = "off" | "normal" | "busy" | "morning";
const RUSH: { id: Rush; key: "rushOff" | "rushNormal" | "rushBusy" | "rushMorning" }[] = [
  { id: "off", key: "rushOff" },
  { id: "normal", key: "rushNormal" },
  { id: "busy", key: "rushBusy" },
  { id: "morning", key: "rushMorning" },
];
const rateFor = (m: Rush, elapsed: number) =>
  m === "normal" ? 6 : m === "busy" ? 30 : m === "morning" ? Math.min(150, 10 + elapsed * 6) : 0; // taps/s

export default function Gate() {
  const { t } = useLang();
  const [city, setCity] = useState(CITIES[0].id);
  const [feed, setFeed] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [per10, setPer10] = useState(0);
  const [peak, setPeak] = useState(0);
  const [blockMs, setBlockMs] = useState(0);
  const [head, setHead] = useState<number | null>(null);
  const [rush, setRush] = useState<Rush>("off");
  const [rate, setRate] = useState(0);
  const [earn, setEarn] = useState<Record<number, number>>({});
  const [shards, setShards] = useState<number[]>(Array(16).fill(0));
  const [riders, setRiders] = useState(0);
  const [openTrips, setOpenTrips] = useState(0);
  const [penalties, setPenalties] = useState(0);
  const [hits, setHits] = useState<Record<string, number>>({});
  const [stress, setStress] = useState<Stress | null>(null);
  const [tokens, setTokens] = useState<Record<number, { t: string; exp: number }>>({});
  const [now, setNow] = useState(Date.now());
  // The turnstile at each station opens only when its tap is CONFIRMED on chain (a TapIn/TapOut event arrives).
  const [gates, setGates] = useState<Record<string, { at: number; rider: string; pen: boolean }>>({});

  const gateKey = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("key") ?? undefined;

  const taps = useRef<number[]>([]);
  const state = useRef({
    last: 0n,
    totalTaps: 0,
    peak: 0,
    cur: { block: -1n, n: 0 },
    earn: {} as Record<number, number>,
    shards: Array(16).fill(0) as number[],
    riders: new Set<string>(),
    open: new Set<string>(),
    penalties: 0,
    hits: {} as Record<string, number>,
    samples: [] as { n: bigint; ts: bigint }[],
  });

  useEffect(() => {
    fetch("/stress.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setStress(j as Stress))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let dead = false;
    const s = state.current;

    const ingest = (evs: Ev[], backfill = false) => {
      if (!evs.length || dead) return;
      const at = Date.now();
      const items: Item[] = [];
      if (!backfill) {
        const penRiders = new Set(evs.filter((x) => x.kind === "pen").map((x) => x.rider));
        const opened: Record<string, { at: number; rider: string; pen: boolean }> = {};
        for (const e of evs) if (e.kind !== "pen") opened[`${e.op}-${e.station}`] = { at, rider: e.rider, pen: penRiders.has(e.rider) };
        if (Object.keys(opened).length) setGates((g) => ({ ...g, ...opened }));
      }
      for (const e of evs) {
        s.riders.add(e.rider);
        items.push({ key: e.key, kind: e.kind, rider: e.rider, op: e.op, station: e.station, fare: e.fare, at });
        if (e.kind === "in") {
          s.open.add(e.rider);
          const k = `${e.op}-${e.station}`;
          s.hits[k] = (s.hits[k] ?? 0) + 1;
        } else if (e.kind === "out") {
          s.open.delete(e.rider);
          const k = `${e.op}-${e.station}`;
          s.hits[k] = (s.hits[k] ?? 0) + 1;
        } else {
          s.penalties++;
        }
        if (e.kind !== "in") {
          s.earn[e.op] = (s.earn[e.op] ?? 0) + e.fare;
          s.shards[shardOf(e.rider)]++;
        }
        if (e.kind !== "pen") {
          if (!backfill) taps.current.push(at);
          s.totalTaps++;
          s.cur = s.cur.block === e.block ? { block: e.block, n: s.cur.n + 1 } : { block: e.block, n: 1 };
          s.peak = Math.max(s.peak, s.cur.n);
        }
      }
      setPeak(s.peak);
      setTotal(s.totalTaps);
      setEarn({ ...s.earn });
      setShards([...s.shards]);
      setRiders(s.riders.size);
      setOpenTrips(s.open.size);
      setPenalties(s.penalties);
      setHits({ ...s.hits });
      setFeed((f) => [...items.reverse(), ...f].slice(0, 6));
    };

    const sample = async (n: bigint) => {
      const b = await publicClient.getBlock({ blockNumber: n });
      s.samples.push({ n, ts: b.timestamp });
      if (s.samples.length > 4) s.samples.shift();
      const a = s.samples[0];
      const z = s.samples[s.samples.length - 1];
      if (z.n > a.n) setBlockMs(Math.round((Number(z.ts - a.ts) * 1000) / Number(z.n - a.n)));
    };

    const tick = async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        setHead(Number(latest));
        let backfill = false;
        if (s.last === 0n) {
          // backfill the last ~90 blocks so the screen is not empty on load
          s.last = latest > 90n ? latest - 90n : 0n;
          backfill = true;
          await sample(latest > 30n ? latest - 30n : 0n);
          await sample(latest);
        }
        if (latest <= s.last) return;
        // public RPC caps eth_getLogs at 100 blocks; catch up in chunks (e.g. after a background tab pause)
        const to = latest - s.last > 90n ? s.last + 90n : latest;
        const logs = await publicClient.getLogs({ address: TURNIKE_ADDRESS, fromBlock: s.last + 1n, toBlock: to });
        s.last = to;
        if (to - s.samples[s.samples.length - 1].n >= 10n) void sample(to);

        const parsed = parseEventLogs({ abi: turnikeAbi, logs, eventName: ["TapIn", "TapOut", "Penalty"] });
        ingest(
          parsed.map((e): Ev => {
            const key = `${e.blockNumber}-${e.logIndex}`;
            const base = { rider: e.args.rider as string, op: Number(e.args.op), block: e.blockNumber, key };
            if (e.eventName === "TapIn") return { ...base, kind: "in", station: Number(e.args.station), from: Number(e.args.station), fare: 0 };
            if (e.eventName === "TapOut") {
              const a = e.args;
              return { ...base, kind: "out", station: Number(a.toStation), from: Number(a.fromStation), fare: Number(formatEther(a.fare)) };
            }
            return { ...base, kind: "pen", station: 0, from: 0, fare: Number(formatEther(e.args.fare)) };
          }),
          backfill,
        );
      } catch {
        /* transient rpc error, next tick retries */
      }
    };

    let stop: () => void;
    if (MOCK) {
      setBlockMs(400);
      stop = onMockEvents((evs) =>
        ingest(evs.map((e): Ev => ({ ...e, kind: e.name === "TapIn" ? "in" : e.name === "TapOut" ? "out" : "pen", block: BigInt(e.block) }))),
      );
    } else {
      const poll = setInterval(tick, 300);
      stop = () => clearInterval(poll);
    }
    const clock = setInterval(() => {
      const cut = Date.now() - 10_000;
      taps.current = taps.current.filter((x) => x > cut);
      setPer10(taps.current.length);
      setNow(Date.now());
      if (MOCK) setHead(Math.floor(Date.now() / 400));
    }, 500);
    return () => {
      dead = true;
      stop();
      clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // demo crowd: bursts every 100 ms at the selected rush rate
  useEffect(() => {
    if (!MOCK || rush === "off") {
      setRate(0);
      return;
    }
    const t0 = Date.now();
    let carry = 0;
    const id = setInterval(() => {
      const r = rateFor(rush, (Date.now() - t0) / 1000);
      setRate(Math.round(r));
      carry += r / 10;
      const n = Math.floor(carry);
      carry -= n;
      if (n > 0) mockCrowdBurst(n);
    }, 100);
    return () => clearInterval(id);
  }, [rush]);

  // rotating station QR tokens for the visible city
  useEffect(() => {
    let dead = false;
    const c = CITIES.find((x) => x.id === city)!;
    const refresh = async () => {
      const out: Record<number, { t: string; exp: number }> = {};
      for (const s of c.stations) {
        const tk = await mintToken(c.id, s.id, gateKey);
        if (tk) out[s.id] = tk;
      }
      if (!dead) setTokens(out);
    };
    void refresh();
    const id = setInterval(refresh, 8_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [city, gateKey]);

  const c = CITIES.find((x) => x.id === city)!;
  const base = `${window.location.origin}${window.location.pathname}`;
  const maxShard = Math.max(1, ...shards);
  const rotating = Object.keys(tokens).length > 0;
  const nextExp = rotating ? Math.min(...Object.values(tokens).map((x) => x.exp)) : 0;
  const secLeft = Math.max(0, Math.ceil((nextExp - now) / 1000));
  const cityStyle = { "--line": c.color } as CSSProperties;

  return (
    <div className="gate">
      <header className="g-head">
        <div className="g-brand">
          <Roundel size={52} />
          <span>Turnike</span>
        </div>

        <div className="g-tabs" role="tablist">
          {CITIES.map((x) => (
            <button key={x.id} role="tab" aria-selected={x.id === city} className={x.id === city ? "on" : ""} onClick={() => setCity(x.id)}>
              <i style={{ background: x.color }} />
              {cityName(x.id)}
            </button>
          ))}
        </div>

        <div className="g-live">
          <span className="livedot" aria-hidden />
          <span>{MOCK ? t("demoChain") : t("live")}</span>
          {head !== null && (
            <span className="g-block">
              <b className="num">{head.toLocaleString("tr-TR")}</b> {t("blockWord")}
            </span>
          )}
          {blockMs > 0 && (
            <span className="g-block">
              <b className="num">{blockMs}</b> {t("msPerBlock")}
            </span>
          )}
          <LangSwitch />
        </div>
      </header>

      <div className="g-cols">
        <section className="g-left">
          <h2>{t("gateHead")}</h2>
          <div className="qr-grid">
            {c.stations.map((s) => {
              const tk = tokens[s.id];
              return (
                <div className="qr-ticket" key={s.id}>
                  <div className="qr-band" style={{ background: c.color }} />
                  <div className="qr-body">
                    <QRCodeSVG value={`${base}#/rider?op=${c.id}&st=${s.id}${tk ? `&t=${tk.t}` : ""}`} size={190} bgColor="#FFFFFF" fgColor="#0A1633" />
                    <div className="qr-name">{s.name}</div>
                    <div className="qr-zone">{t("zone", { z: s.zone })}</div>
                    {(() => {
                      const g = gates[`${c.id}-${s.id}`];
                      const open = !!g && now - g.at < 3000;
                      return (
                        <div className={`gate-state ${open ? (g.pen ? "pen" : "open") : ""}`} role="status">
                          <span className="arm" aria-hidden />
                          <span>{open ? (g.pen ? t("gatePenalty") : t("gateOpenNow")) : t("gateClosed")}</span>
                          {open && <span className="who">{short(g.rider)}</span>}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
          <p className={`qrnote ${rotating ? "ok" : ""}`}>{rotating ? t("rotatingQr", { s: secLeft }) : t("staticQr")}</p>
        </section>

        <section className="g-rightcol">
          <div className="g-tiles">
            <div className="g-tile" style={cityStyle}>
              <div className="num g-n">{total.toLocaleString("tr-TR")}</div>
              <div className="g-l">{t("tileTotal")}</div>
            </div>
            <div className="g-tile" style={cityStyle}>
              <div className="num g-n">{per10.toLocaleString("tr-TR")}</div>
              <div className="g-l">{rate ? `${t("tileLast10")}, ${t("target", { n: rate })}` : t("tileLast10")}</div>
            </div>
            <div className="g-tile" style={cityStyle}>
              <div className="num g-n">{peak.toLocaleString("tr-TR")}</div>
              <div className="g-l">{t("tilePeak")}</div>
            </div>
            <div className="g-tile" style={cityStyle}>
              <div className="num g-n">{(earn[city] ?? 0).toFixed(3)}</div>
              <div className="g-l">{t("tileEarn", { city: cityName(city) })}</div>
            </div>
          </div>

          <h2>{t("feedTitle")}</h2>
          <div className="board">
            {feed.length === 0 && <div className="board-empty">{t("feedEmpty")}</div>}
            {feed.map((i) => (
              <div className="b-row" key={i.key} style={{ borderLeftColor: cityColor(i.op) }}>
                <span className="b-time num">{hms(i.at)}</span>
                <span className="b-st">
                  <b>{i.kind === "pen" ? t("penStation") : stationName(i.op, i.station)}</b>
                  <small>{cityName(i.op)}</small>
                </span>
                <span className="b-who">{short(i.rider)}</span>
                <span className={`b-act ${i.kind}`}>
                  {i.kind === "in" ? t("actIn") : i.kind === "out" ? `${t("actOut")} −${i.fare.toFixed(3)}` : `${t("actPen")} −${i.fare.toFixed(2)}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="g-extra">
        <div className="x-card">
          {MOCK && (
            <div className="rush">
              <span className="x-h">{t("load")}</span>
              {RUSH.map((r) => (
                <button key={r.id} className={rush === r.id ? "on" : ""} onClick={() => setRush(r.id)}>
                  {t(r.key)}
                </button>
              ))}
            </div>
          )}
          <div className="x-stats">
            <div><b className="num">{(per10 / 10).toFixed(1)}</b><span>{t("perSec")}</span></div>
            <div><b className="num">{riders.toLocaleString("tr-TR")}</b><span>{t("riders")}</span></div>
            <div><b className="num">{openTrips.toLocaleString("tr-TR")}</b><span>{t("openTrips")}</span></div>
            <div><b className="num bad">{penalties.toLocaleString("tr-TR")}</b><span>{t("penalties")}</span></div>
          </div>
          {stress && (
            <>
              <div className="x-h">{t("stressTitle")}</div>
              <p className="x-note">{t("stressLine", { n: stress.taps, b: stress.blocks, s: stress.seconds, p: stress.peak })}</p>
            </>
          )}
        </div>

        <div className="x-card">
          <div className="x-h">{t("whyMonad")}</div>
          <div className="cmp">
            <div className="bar">
              <span>Monad</span>
              <div className="tr"><div className="fl ok" style={{ width: `${Math.max(2, ((blockMs || 400) / ETH_BLOCK_MS) * 100)}%` }} /></div>
              <span className="num">{blockMs || 400} ms</span>
            </div>
            <div className="bar">
              <span>{t("vsBlock")}</span>
              <div className="tr"><div className="fl bad" style={{ width: "100%" }} /></div>
              <span className="num">12 000 ms</span>
            </div>
          </div>
          <div className="x-h">{t("parallel")}</div>
          <div className="shards">
            {shards.map((n, i) => (
              <div key={`${i}-${n}`} className={`cell ${n ? "flash" : ""}`} style={{ boxShadow: n ? `inset 0 -${Math.round((n / maxShard) * 28)}px 0 rgba(255,201,60,.35)` : undefined }}>
                {n || ""}
              </div>
            ))}
          </div>
          <p className="x-note">{t("shardNote")}</p>
        </div>

        <div className="x-card">
          <div className="x-h">{t("networkMap")}</div>
          <div className="netmap">
            {CITIES.map((x) => {
              const maxZ = Math.max(...x.stations.map((s) => s.zone), 1);
              return (
                <div key={x.id} className="line">
                  <span className="cn" style={{ color: "#FFFFFF" }}>
                    <i style={{ background: x.color }} />
                    {cityName(x.id)}
                  </span>
                  <svg viewBox="0 0 300 46" preserveAspectRatio="none">
                    <line x1="14" y1="16" x2="286" y2="16" stroke={x.color} strokeWidth="5" />
                    {x.stations.map((s) => {
                      const cx = 14 + (s.zone / maxZ) * 272;
                      const h = hits[`${x.id}-${s.id}`] ?? 0;
                      return (
                        <g key={s.id}>
                          <circle key={h} cx={cx} cy="16" r="9" fill="#0A1633" stroke={x.color} strokeWidth="4" className={h ? "pulse" : ""} />
                          <text x={cx} y="40" textAnchor="middle" fontSize="11" fill="#C3CEE6">{s.name} {h}</text>
                          <title>{`${s.name}, ${t("zone", { z: zoneOf(x.id, s.id) })}`}</title>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              );
            })}
          </div>
          <div className="x-h">{t("earnings")}</div>
          <div className="earn">
            {CITIES.map((x) => (
              <div className="e" key={x.id}>
                <span><i style={{ background: x.color }} />{cityName(x.id)}</span>
                <b className="num">{(earn[x.id] ?? 0).toFixed(3)} <small>{t("mon")}</small></b>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
