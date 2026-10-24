import { useState } from "react";
import { CITIES, TARIFFS, cityName, centsOf, lira, monFromCents, stationName, zonesBetween } from "../lib/config";
import { useLang } from "../lib/i18n";
import { useRate } from "../lib/rate";

export default function FareCalc({ defaultOp = 1 }: { defaultOp?: number }) {
  const { t, lang } = useLang();
  const rate = useRate();
  const [op, setOp] = useState(defaultOp);
  const [a, setA] = useState(1);
  const [b, setB] = useState(3);
  const [transfer, setTransfer] = useState(false);
  const city = CITIES.find((c) => c.id === op) ?? CITIES[0];
  const tariff = TARIFFS[city.id];
  const d = zonesBetween(city.id, a, b);
  const raw = (transfer ? 0 : tariff.base) + d * tariff.per;
  const cents = centsOf(city.id, a, b, transfer);

  return (
    <details className="calc">
      <summary>{t("calcTitle")}</summary>
      <div className="calc-grid">
        <label>
          {t("calcCity")}
          <select
            value={op}
            onChange={(e) => {
              setOp(Number(e.target.value));
              setA(1);
              setB(3);
            }}
          >
            {CITIES.map((c) => (
              <option key={c.id} value={c.id}>
                {cityName(c.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("calcFrom")}
          <select value={a} onChange={(e) => setA(Number(e.target.value))}>
            {city.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {stationName(city.id, s.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("calcTo")}
          <select value={b} onChange={(e) => setB(Number(e.target.value))}>
            {city.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {stationName(city.id, s.id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={transfer} onChange={(e) => setTransfer(e.target.checked)} />
        {t("calcTransfer")}
      </label>
      <div className="calc-out">
        <div className="num big">{lira(cents, lang)}</div>
        <div className="mute">
          {monFromCents(cents, rate).toFixed(3)} MON, {t("calcFormula", { base: lira(transfer ? 0 : tariff.base, lang), d, per: lira(tariff.per, lang) })}
          {raw > tariff.max && `, ${t("calcCapped", { max: lira(tariff.max, lang) })}`}
        </div>
        <div className="mute small">{t("calcRate", { x: monFromCents(100, rate).toFixed(4) })}</div>
      </div>
    </details>
  );
}
