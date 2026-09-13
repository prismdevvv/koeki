"use client";

import { useState } from "react";
import { HandCoins, Plus, X } from "lucide-react";

interface ResourceOption { id: string; name: string; donLabel: string; points: number; rate: number }
interface Row { text: string; quantity: string }

const MAX_ROWS = 8;
const formatRyo = (value: number) => new Intl.NumberFormat("fr-FR").format(value);
const normalize = (value: string) => value.trim().toLowerCase();
const warnStyle = { color: "var(--terracotta-300)", textTransform: "none", letterSpacing: "normal" } as const;

export function NinjaDonationItems({ resources, taxCoverageBps }: { resources: ResourceOption[]; taxCoverageBps: number }) {
  const [rows, setRows] = useState<Row[]>([{ text: "", quantity: "" }]);
  const resolve = (text: string) => {
    const query = normalize(text);
    if (!query) return null;
    return resources.find((resource) => normalize(resource.donLabel) === query) ?? resources.find((resource) => normalize(resource.name) === query) ?? null;
  };
  const update = (index: number, patch: Partial<Row>) => setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const matchedRows = rows.map((row) => ({ matched: resolve(row.text), quantity: Number.parseInt(row.quantity, 10) || 0 }));
  const totals = matchedRows.reduce((sum, row) => (row.matched ? { points: sum.points + row.quantity * row.matched.points, exemption: sum.exemption + row.quantity * row.matched.rate } : sum), { points: 0, exemption: 0 });

  return <>
    <datalist id="objets-don-fiche">{resources.map((resource) => <option key={resource.id} value={resource.donLabel} />)}</datalist>
    <fieldset>
      <legend>Objets donnés — le barème points/exonération s’affiche dans chaque proposition</legend>
      {rows.map((row, index) => {
        const matched = resolve(row.text);
        return <div key={index} className="item-row">
          <label>Ressource {index + 1}{row.text && !matched && <small style={warnStyle}> — choisissez une proposition</small>}
            <input list="objets-don-fiche" value={row.text} placeholder="Fer, Bague T4, Plan…" autoComplete="off" onChange={(event) => update(index, { text: event.target.value })} />
            <input type="hidden" name={`resourceId_${index + 1}`} value={matched?.id ?? ""} />
          </label>
          <label>Quantité<input type="number" name={`quantity_${index + 1}`} min={0} step={1} value={row.quantity} onChange={(event) => update(index, { quantity: event.target.value })} /></label>
          <button type="button" className="button button-ghost" aria-label={`Retirer la ressource ${index + 1}`} disabled={rows.length === 1 && !row.text && !row.quantity} onClick={() => (rows.length === 1 ? setRows([{ text: "", quantity: "" }]) : setRows(rows.filter((_, i) => i !== index)))}><X size={14} /></button>
        </div>;
      })}
      {rows.length < MAX_ROWS && <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => setRows([...rows, { text: "", quantity: "" }])}><Plus size={14} /> Ajouter une ressource</button></div>}
    </fieldset>
    <p className="notice" role="status" style={{ margin: 0 }} aria-live="polite">
      Le ninja gagnera <strong>{formatRyo(totals.points)} point{totals.points > 1 ? "s" : ""}</strong> et <strong>{formatRyo(totals.exemption)} ¥</strong> de crédit d’exonération conservé.
      {taxCoverageBps === 0 ? " Application aux taxes actuellement suspendue (0 %)." : ` Le crédit peut couvrir au plus ${(taxCoverageBps / 100).toLocaleString("fr-FR")} % de chaque taxe.`}
    </p>
    <div className="form-actions"><button className="button button-primary" type="submit"><HandCoins size={16} /> Enregistrer le don</button></div>
  </>;
}
