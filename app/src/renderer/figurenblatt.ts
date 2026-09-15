// DIE VORSCHAU DER AGENTENFIGUREN (Bau-Schritt 4, Auftrag ansicht4e, 10.09.2026).
//
// Die Sichtpruefung fuer alice: alle Rollen der Bibliothek in BEIDEN Arten,
// der Hauptagent und der Reviewer, alle Zustaende je Art, Instanzen derselben
// Rolle und die fuenf Groessen -- dieselben Abschnitte wie das abgenommene
// Blatt docs/agentenfiguren.html, gezeichnet vom Modul, das auch die Ansicht
// benutzt. Sie liegt als Flaeche im Agents-Blatt (Knopf „Figuren"): ein eigenes
// Fenster braeuchte den Hauptprozess, und der gehoert in diesem Schritt dem
// Kern-Worker.
import { t } from './texte';
import {
  BIBLIOTHEK, FIGUR_ZUSTAENDE, artEingestellt, artVon, artVorgabe, figur, figurDeckung, figurenAufraeumen, figurenStand,
  rollenName, type Art, type FigurWunsch, type FigurZustand,
} from './agentenfigur';

let ziel: HTMLElement | null = null;
let gebaut = '';

export function initFigurenblatt(el: HTMLElement): void {
  ziel = el;
}

/** Das Wort eines Figurenzustands -- dieselben Woerter wie in der Ansicht. */
function zustandWort(z: FigurZustand | 'ruhig'): string {
  const vertrag: Record<string, string> = {
    arbeitet: 'arbeitet', ungelesen: 'ergebnis_ungelesen', entscheidung: 'braucht_entscheidung',
    haengt: 'haengt', fertig: 'fertig', fern: 'nicht_einsehbar',
  };
  return z === 'ruhig' ? t('figuren.ruhig') : t(`agents.zustand.${vertrag[z]}`);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, klasse?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

function kachel(w: FigurWunsch, beschriftung?: string, unter?: string): HTMLDivElement {
  const k = el('div', 'fg-kachel');
  k.append(figur({ ...w, titel: w.titel ?? beschriftung }));
  if (beschriftung) k.append(el('div', 'fg-cap', beschriftung));
  if (unter) k.append(el('div', 'fg-unter', unter));
  return k;
}

function abschnitt(titel: string): HTMLElement {
  const s = el('section', 'fg-abschnitt');
  s.append(el('h3', 'fg-titel', titel));
  return s;
}

/** Baut die Vorschau -- neu nur, wenn sich Arten, Bewegung oder Sprache geaendert haben. */
export function figurenblattZeichnen(erzwingen = false): void {
  if (!ziel) return;
  const merkmal = JSON.stringify([BIBLIOTHEK.map((b) => artVon(b.team)), figurenStand().reduziert, t('figuren.titel')]);
  if (!erzwingen && merkmal === gebaut && ziel.childElementCount) return;
  gebaut = merkmal;
  ziel.replaceChildren();

  const kopf = el('header', 'fg-kopf');
  kopf.append(el('h2', 'fg-haupttitel', t('figuren.titel')), el('p', 'fg-einleitung', t('figuren.einleitung')));
  if (figurenStand().reduziert) kopf.append(el('p', 'fg-hinweis', t('figuren.reduziert')));
  ziel.append(kopf);

  // Die zwei Einzelnen.
  const einzeln = abschnitt(t('figuren.einzelne'));
  const zwei = el('div', 'fg-zwei');
  for (const [rolle, titel, reihe] of [
    ['hauptagent', t('figuren.kern'), ['ruhig', 'arbeitet', 'ungelesen']],
    ['reviewer', t('figuren.linse'), ['ruhig', 'arbeitet', 'entscheidung']],
  ] as [string, string, (FigurZustand | 'ruhig')[]][]) {
    const spalte = el('div', 'fg-spalte');
    spalte.append(el('div', 'fg-untertitel', titel));
    const r = el('div', 'fg-reihe');
    for (const z of reihe) {
      r.append(kachel({ rolle, stufe: rolle === 'hauptagent' ? 'hauptagent' : 'mitglied', groesse: z === 'ruhig' ? 96 : 64, zustand: z }, zustandWort(z)));
    }
    spalte.append(r);
    zwei.append(spalte);
  }
  einzeln.append(zwei);
  ziel.append(einzeln);

  // Alle Rollen der Bibliothek, jede in beiden Arten.
  const teams = abschnitt(t('figuren.teams'));
  for (const b of BIBLIOTHEK) {
    const box = el('div', 'fg-team');
    box.dataset.team = b.team;
    const kopfzeile = el('div', 'fg-team-kopf');
    const artWort = (a: Art): string => t(`figuren.art.${a}`);
    kopfzeile.append(el('span', 'fg-team-name', t(`figuren.team.${b.team}`)));
    // „eingestellt" nur, wo die Einstellung von der Vorgabe abweicht: der Kern
    // schickt die Art jedes Teams mit, auch die unveraenderte.
    kopfzeile.append(el('span', 'fg-team-art', artVon(b.team) !== artVorgabe(b.team)
      ? `${t('figuren.eingestellt', { art: artWort(artVon(b.team)) })} · ${t('figuren.vorgabe', { art: artWort(artVorgabe(b.team)) })}`
      : t('figuren.vorgabe', { art: artWort(artVorgabe(b.team)) })));
    box.append(kopfzeile);
    for (const art of ['roboter', 'tier'] as Art[]) {
      const reihe = el('div', 'fg-artreihe');
      reihe.dataset.art = art;
      reihe.classList.toggle('gewaehlt', artVon(b.team) === art);
      reihe.append(el('div', 'fg-artname', artWort(art)));
      const r = el('div', 'fg-reihe');
      for (const rolle of b.rollen) {
        r.append(kachel({ rolle: rolle.rolle, stufe: rolle.stufe, team: b.team, art, groesse: 44 }, rolle.name,
          rolle.stufe === 'teamleiter' ? t('agents.rolle.teamleiter') : rolle.rolle));
      }
      reihe.append(r);
      box.append(reihe);
    }
    teams.append(box);
  }
  ziel.append(teams);

  // Alle Zustaende je Art.
  const zustaende = abschnitt(t('figuren.zustaende'));
  for (const [titel, rolle, team, stufe, art] of [
    [t('figuren.art.roboter'), 'junior-dev', 'entwicklung', 'mitglied', 'roboter'],
    [t('figuren.art.tier'), 'recherche-laeufer', 'recherche', 'mitglied', 'tier'],
    [t('figuren.kern'), 'hauptagent', 'hauptagent', 'hauptagent', undefined],
    [t('figuren.linse'), 'reviewer', 'pruefung', 'mitglied', undefined],
  ] as [string, string, string, string, Art | undefined][]) {
    const box = el('div', 'fg-zustandsblock');
    box.append(el('div', 'fg-untertitel', titel));
    const r = el('div', 'fg-reihe');
    for (const z of ['ruhig', ...FIGUR_ZUSTAENDE] as (FigurZustand | 'ruhig')[]) {
      r.append(kachel({ rolle, team, stufe, art, groesse: 64, zustand: z }, zustandWort(z)));
    }
    box.append(r);
    zustaende.append(box);
  }
  ziel.append(zustaende);

  // Gleiche Rolle, nie dieselbe Figur.
  const instanzen = abschnitt(t('figuren.instanzen'));
  for (const [rolle, team, stufe, namen] of [
    ['recherche-laeufer', 'recherche', 'mitglied', ['agentsweb', 'agentsscout', 'quellen-3', 'nachtlauf']],
    ['junior-dev', 'entwicklung', 'mitglied', ['kal-2', 'ui-fix', 'tests-b', 'parser']],
    ['hauptagent', 'hauptagent', 'hauptagent', ['agents-plan', 'npc-1', 'probe-kal']],
    ['reviewer', 'pruefung', 'mitglied', ['plan-review', 'rev-kal', 'rev-npc']],
  ] as [string, string, string, string[]][]) {
    const box = el('div', 'fg-zustandsblock');
    box.append(el('div', 'fg-untertitel', rollenName(rolle)));
    const r = el('div', 'fg-reihe');
    for (const n of namen) r.append(kachel({ rolle, team, stufe, name: n, groesse: 64 }, n));
    box.append(r);
    instanzen.append(box);
  }
  ziel.append(instanzen);

  // Die fuenf Groessen der Plattformen.
  const groessen = abschnitt(t('figuren.groessen'));
  const r = el('div', 'fg-reihe fg-groessen');
  for (const g of [16, 32, 44, 64, 96]) {
    const spalte = el('div', 'fg-groesse');
    const figuren = el('div', 'fg-reihe');
    for (const [rolle, team, stufe] of [
      ['hauptagent', 'hauptagent', 'hauptagent'], ['senior-dev', 'entwicklung', 'mitglied'],
      ['quellenpruefer', 'recherche', 'mitglied'], ['reviewer', 'pruefung', 'mitglied'],
    ]) {
      figuren.append(figur({ rolle, team, stufe, groesse: g, zustand: 'ungelesen', titel: `${rollenName(rolle)} ${g} pt` }));
    }
    spalte.append(figuren, el('div', 'fg-cap', `${g} pt`));
    r.append(spalte);
  }
  groessen.append(r);
  ziel.append(groessen);
  // Die Figuren des vorigen Baus haengen nicht mehr: austragen, sonst
  // blieben sie bei reduzierter Bewegung im Speicher (Befund M3).
  figurenAufraeumen();
}

/** Was eine Suite ueber die Vorschau wissen will -- aus dem DOM, nicht aus dem Plan. */
export function figurenblattZustand(): Record<string, unknown> {
  if (!ziel) return {};
  const cs = [...ziel.querySelectorAll<HTMLCanvasElement>('canvas.agentenfigur')];
  const gestalten: Record<string, number> = {};
  const zustaende: Record<string, string[]> = {};
  const ungedeckt: string[] = [];
  for (const c of cs) {
    const g = c.dataset.gestalt ?? '';
    gestalten[g] = (gestalten[g] ?? 0) + 1;
    const z = c.dataset.zustand ?? '';
    zustaende[g] = [...new Set([...(zustaende[g] ?? []), z])].sort();
    if (figurDeckung(c) <= 0.01) ungedeckt.push(c.dataset.figur ?? '');
  }
  return {
    sichtbar: !ziel.hidden,
    figuren: cs.length,
    gestalten,
    zustaende,
    gedeckt: cs.length - ungedeckt.length,
    ungedeckt,
    groessen: [...new Set(cs.map((c) => parseInt(c.style.width, 10)))].sort((a, b) => a - b),
    rollen: [...new Set(cs.map((c) => (c.dataset.figur ?? '').split('|')[0]))].sort(),
    teams: BIBLIOTHEK.map((b) => ({ team: b.team, art: artVon(b.team), vorgabe: artVorgabe(b.team), eingestellt: artEingestellt(b.team) })),
    // Je Team: wie viele Figuren in welcher Art wirklich gezeichnet stehen.
    teamReihen: [...ziel.querySelectorAll<HTMLElement>('.fg-team')].map((box) => ({
      team: box.dataset.team ?? '',
      ...Object.fromEntries([...box.querySelectorAll<HTMLElement>('.fg-artreihe')].map((r) => [
        r.dataset.art ?? '',
        [...r.querySelectorAll<HTMLCanvasElement>('canvas.agentenfigur')].filter((c) => c.dataset.gestalt === r.dataset.art && figurDeckung(c) > 0.01).length,
      ])),
    })),
    titel: (ziel.querySelector('.fg-haupttitel')?.textContent ?? '').trim(),
    hinweis: (ziel.querySelector('.fg-hinweis')?.textContent ?? '').trim(),
  };
}
