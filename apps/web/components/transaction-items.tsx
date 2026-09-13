"use client";

import { useState } from "react";
import { HandCoins, Plus, X } from "lucide-react";

interface NinjaOption { id: string; name: string; label: string }
interface ResourceOption { id: string; name: string; donLabel: string; buyLabel: string; points: number; rate: number; price: number; hasPrice: boolean }
interface Row { text: string; quantity: string; price: string }

const MAX_ROWS = 8;
const formatRyo = (value: number) => new Intl.NumberFormat("fr-FR").format(value);
const normalize = (value: string) => value.trim().toLowerCase();
const warnStyle = { color: "var(--terracotta-300)", textTransform: "none", letterSpacing: "normal" } as const;

export function TransactionItems({ ninjas, resources, taxCoverageBps }: { ninjas: NinjaOption[]; resources: ResourceOption[]; taxCoverageBps: number }) {
  const [type, setType] = useState<"DONATION" | "BUYBACK">("DONATION");
  const [ninjaText, setNinjaText] = useState("");
  const [rows, setRows] = useState<Row[]>([{ text: "", quantity: "", price: "" }]);
  const ninja = (() => {
    const query = normalize(ninjaText);
    if (!query) return null;
    return ninjas.find((entry) => normalize(entry.label) === query) ?? ninjas.find((entry) => normalize(entry.name) === query) ?? null;
  })();
  const resolve = (text: string) => {
    const query = normalize(text);
    if (!query) return null;
    return resources.find((resource) => normalize(resource.donLabel) === query)
      ?? resources.find((resource) => normalize(resource.buyLabel) === query)
      ?? resources.find((resource) => normalize(resource.name) === query) ?? null;
  };
  const update = (index: number, patch: Partial<Row>) => setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  // Changing the item prefills the negotiable unit price with the catalog maximum.
  const updateText = (index: number, text: string) => {
    const previous = resolve(rows[index]?.text ?? "");
    const matched = resolve(text);
    const patch: Partial<Row> = { text };
    if (matched && matched.id !== previous?.id) patch.price = matched.price > 0 ? String(matched.price) : "";
    update(index, patch);
  };
  const matchedRows = rows.map((row) => ({ matched: resolve(row.text), quantity: Number.parseInt(row.quantity, 10) || 0, price: Number.parseInt(row.price, 10) || 0 }));
  const totals = matchedRows.reduce((sum, row) => (row.matched ? {
    points: sum.points + row.quantity * row.matched.points,
    exemption: sum.exemption + row.quantity * row.matched.rate,
    payout: sum.payout + row.quantity * (row.price || row.matched.price)
  } : sum), { points: 0, exemption: 0, payout: 0 });
  const missingPrice = type === "BUYBACK" ? matchedRows.filter((row) => row.matched && row.quantity > 0 && !row.matched.hasPrice).map((row) => row.matched!.name) : [];
  const overMax = type === "BUYBACK" ? matchedRows.filter((row) => row.matched && row.matched.hasPrice && row.price > row.matched.price).map((row) => `${row.matched!.name} (max ${formatRyo(row.matched!.price)} ¥)`) : [];

  return <>
    <datalist id="ninjas-registre">{ninjas.map((entry) => <option key={entry.id} value={entry.label} />)}</datalist>
    <datalist id="objets-don">{resources.map((resource) => <option key={resource.id} value={resource.donLabel} />)}</datalist>
    <datalist id="objets-rachat">{resources.map((resource) => <option key={resource.id} value={resource.buyLabel} />)}</datalist>
    <div className="form-row">
      <label>Type d’opération<select name="type" required value={type} onChange={(event) => setType(event.target.value === "BUYBACK" ? "BUYBACK" : "DONATION")}><option value="DONATION">Don (points + exonération)</option><option value="BUYBACK">Rachat (payé en Ryō)</option></select></label>
      <label>Ninja{ninjaText && !ninja && <small style={warnStyle}> — choisissez une proposition</small>}
        <input list="ninjas-registre" value={ninjaText} placeholder="Tapez un nom ou un code NIN-…" autoComplete="off" onChange={(event) => setNinjaText(event.target.value)} required />
        <input type="hidden" name="zenkaiCharKey" value={ninja?.id ?? ""} />
      </label>
    </div>
    <fieldset>
      <legend>{type === "BUYBACK" ? "Ressources rachetées — le prix actif s’affiche dans chaque proposition" : "Objets donnés — le barème points/exonération s’affiche dans chaque proposition"}</legend>
      {rows.map((row, index) => {
        const matched = resolve(row.text);
        const lineTotal = (Number.parseInt(row.quantity, 10) || 0) * ((Number.parseInt(row.price, 10) || 0) || matched?.price || 0);
        return <div key={index} className={type === "BUYBACK" ? "item-row with-price" : "item-row"}>
          <label>Ressource {index + 1}{row.text && !matched && <small style={warnStyle}> — choisissez une proposition</small>}
            <input list={type === "BUYBACK" ? "objets-rachat" : "objets-don"} value={row.text} placeholder="Fer, Bague T4, Plan…" autoComplete="off" onChange={(event) => updateText(index, event.target.value)} />
            <input type="hidden" name={`resourceId_${index + 1}`} value={matched?.id ?? ""} />
          </label>
          <label>Quantité<input type="number" name={`quantity_${index + 1}`} min={0} step={1} value={row.quantity} onChange={(event) => update(index, { quantity: event.target.value })} /></label>
          {type === "BUYBACK" && <label>Prix/u négocié{matched?.hasPrice && <small style={{ textTransform: "none", letterSpacing: "normal" }}> (max {formatRyo(matched.price)})</small>}
            <input type="number" name={`unitPrice_${index + 1}`} min={1} max={matched?.hasPrice ? matched.price : undefined} step={1} value={row.price} placeholder={matched?.hasPrice ? String(matched.price) : "—"} onChange={(event) => update(index, { price: event.target.value })} />
          </label>}
          <button type="button" className="button button-ghost" aria-label={`Retirer la ressource ${index + 1}`} disabled={rows.length === 1 && !row.text && !row.quantity} onClick={() => (rows.length === 1 ? setRows([{ text: "", quantity: "", price: "" }]) : setRows(rows.filter((_, i) => i !== index)))}><X size={14} /></button>
          {type === "BUYBACK" && matched && lineTotal > 0 && <small style={{ gridColumn: "1 / -1", color: "var(--sand-500)", marginTop: -6 }}>Sous-total : {formatRyo(lineTotal)} ¥</small>}
        </div>;
      })}
      {rows.length < MAX_ROWS && <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => setRows([...rows, { text: "", quantity: "", price: "" }])}><Plus size={14} /> Ajouter une ressource</button></div>}
    </fieldset>
    {missingPrice.length > 0 && <p className="notice error" role="alert">Sans prix actif : {missingPrice.join(", ")} — configurez le prix depuis le catalogue avant le rachat.</p>}
    {overMax.length > 0 && <p className="notice error" role="alert">Prix négocié au-dessus du catalogue : {overMax.join(", ")} — le prix catalogue est un maximum, on ne négocie qu’à la baisse.</p>}
    <p className="notice" role="status" style={{ margin: 0 }} aria-live="polite">
      {type === "BUYBACK"
        ? <>Total à payer au ninja : <strong>{formatRyo(totals.payout)} ¥</strong> (prix négociés) — également ajouté à son crédit d’exonération conservé.</>
        : <>Le ninja gagnera <strong>{formatRyo(totals.points)} point{totals.points > 1 ? "s" : ""}</strong> et <strong>{formatRyo(totals.exemption)} ¥</strong> de crédit d’exonération conservé.</>}
      {taxCoverageBps === 0 ? " Application aux taxes actuellement suspendue (0 %)." : ` Le crédit peut couvrir au plus ${(taxCoverageBps / 100).toLocaleString("fr-FR")} % de chaque taxe.`}
    </p>
    <div className="form-actions"><button className="button button-primary" type="submit"><HandCoins size={16} /> {type === "BUYBACK" ? "Enregistrer le rachat" : "Enregistrer le don"}</button></div>
  </>;
}
