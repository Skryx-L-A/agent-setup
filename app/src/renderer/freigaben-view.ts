// Die Freigabe-Ansicht (V20): ein Posteingang fuer zwei Arten von Eintraegen.
//
//   Antraege             wb-request/wb-decide -- Annehmen/Ablehnen ruft hier
//                        GENAU dieses Werkzeug auf (ueber den Hauptprozess).
//                        Ein Worker spawnt in diesem Haus nie selbst: Annehmen
//                        heisst "der Orchestrator wird spawnen", nicht "es
//                        spawnt jetzt" -- das sagt der Knopftext ausdruecklich.
//   Angehaltene Worker   von bash-guard.py geschrieben, sobald er einen Bash-
//                        Befehl ablehnt. Kein Annehmen/Ablehnen -- eine echte
//                        Berechtigungsfrage laesst sich nur in der Pane selbst
//                        beantworten. Der Knopf hier springt dorthin.
import './freigaben-view.css';
import { registriere, umschalten } from './flaeche';

interface RequestEntry {
  path: string; ts: string; parent: string; parentModel: string;
  childName: string; childModel: string; childEffort: string; dir: string;
  files: string[]; task: string; doneCriterion: string; whySeparable: string; est: string;
}
interface GuardBlockEntry {
  path: string; pane: string; guard: string; reason: string; command: string;
  cwd: string; ts: string; sessionId: string; sessionName: string; machine: string;
  workerName: string; unbekannterPane: boolean;
  /** Die mittlere Stufe: wartet auf eine einmalige Freigabe statt endgueltig abgelehnt zu sein. */
  wartet: boolean; muster: string; musterGrund: string; schluessel: string;
}
/** V17: der Verlauf ALLER Ablehnungen, gruppiert nach (guard, reason) -- sichtbar machen, welche Muster WIEDERHOLT anschlagen. */
interface GuardLogGruppe {
  guard: string; reason: string; anzahl: number; ersteMs: number; letzteMs: number; letzterBefehl: string;
}
interface FreigabenPayload { requests: RequestEntry[]; guardBlocks: GuardBlockEntry[]; guardLog: GuardLogGruppe[] }

function seitHer(ts: string): string {
  const dann = Date.parse(ts);
  if (!Number.isFinite(dann)) return ts || '-';
  return seitHerMs(dann);
}

/** Dieselbe Ableitung wie seitHer(), aber ab einem bereits geparsten Zeitpunkt (V17: guardLog traegt ms, keine ISO-Zeichenkette). */
function seitHerMs(dann: number): string {
  if (!dann) return '-';
  const min = Math.max(0, Math.round((Date.now() - dann) / 60000));
  if (min < 1) return 'gerade eben';
  if (min < 60) return `seit ${min} Min.`;
  const std = Math.floor(min / 60);
  return `seit ${std} Std. ${min % 60} Min.`;
}

/**
 * Fuer den Steuerkanal (`awb-ctl ui`): was die Ansicht GERADE ZEICHNET, aus
 * dem DOM gelesen -- damit eine Pruefung nicht nur die Nutzlast sieht, sondern
 * auch, dass sie wirklich auf dem Bildschirm steht.
 */
export function freigabenUiState(): {
  offen: boolean; blocks: number; requests: number; verlauf: number;
  blockTexte: string[]; requestTexte: string[]; verlaufTexte: string[];
} {
  const panel = document.getElementById('fg-panel');
  const offen = !!panel?.classList.contains('offen');
  const blocks = [...(panel?.querySelectorAll('[data-liste="blocks"] .fg-block') ?? [])];
  const requests = [...(panel?.querySelectorAll('[data-liste="requests"] .fg-antrag') ?? [])];
  const verlauf = [...(panel?.querySelectorAll('[data-liste="verlauf"] .fg-verlauf') ?? [])];
  return {
    offen,
    blocks: blocks.length,
    requests: requests.length,
    verlauf: verlauf.length,
    blockTexte: blocks.map((e) => (e.textContent ?? '').trim()),
    requestTexte: requests.map((e) => (e.textContent ?? '').trim()),
    verlaufTexte: verlauf.map((e) => (e.textContent ?? '').trim()),
  };
}

export function initFreigabenView(): void {
  const knopf = document.querySelector<HTMLButtonElement>('.knopf[data-tot="freigaben"]');
  if (!knopf) return;
  const knopfEl = knopf;

  const panel = document.createElement('div');
  panel.id = 'fg-panel';
  panel.className = 'fg-panel';
  panel.innerHTML = `
    <div class="fg-kopf">
      <div class="fg-titel">Freigaben</div>
      <button type="button" class="fg-schliessen" title="Schliessen">&times;</button>
    </div>
    <div class="fg-inhalt">
      <div class="fg-abschnitt" data-abschnitt="blocks">
        <div class="fg-abschnitt-titel">Angehaltene Worker</div>
        <div class="fg-liste" data-liste="blocks"></div>
      </div>
      <div class="fg-abschnitt" data-abschnitt="verlauf">
        <div class="fg-abschnitt-titel">Guard-Verlauf</div>
        <div class="fg-hinweis">Welche Muster WIEDERHOLT anschlagen -- gruppiert, nicht nur der laufende Block oben (V17).</div>
        <div class="fg-liste" data-liste="verlauf"></div>
      </div>
      <div class="fg-abschnitt" data-abschnitt="requests">
        <div class="fg-abschnitt-titel">Antraege</div>
        <div class="fg-liste" data-liste="requests"></div>
      </div>
    </div>`;
  // Die Schublade haengt in der Reihe zwischen Sessionleiste und Buehne,
  // nicht am Rumpf: nur dort nimmt sie Platz weg, statt sich darueber zu
  // legen. Fehlt der Platzhalter, bleibt der Rumpf die Notloesung.
  (document.getElementById('schublade') ?? document.body).appendChild(panel);

  const listeBlocks = panel.querySelector<HTMLDivElement>('[data-liste="blocks"]')!;
  const listeVerlauf = panel.querySelector<HTMLDivElement>('[data-liste="verlauf"]')!;
  const listeRequests = panel.querySelector<HTMLDivElement>('[data-liste="requests"]')!;

  let letzte: FreigabenPayload = { requests: [], guardBlocks: [], guardLog: [] };
  /** Die zuletzt GEZEICHNETE Nutzlast als Zeichenkette -- siehe `onFreigaben` unten. */
  let letzteSignatur = '';
  let offen = false;

  /**
   * Was im Begruendungsfeld steht, ueberlebt hier ein Neuzeichnen: je Eintrag
   * unter seiner STABILEN Kennung (wartender Block: `b.schluessel`, Antrag:
   * `r.path`). Beides benennt dieselbe Sache auch dann noch, wenn die Liste
   * dazwischen neu gebaut wurde.
   *
   * Der Anlass (19.08.): `zeichnen()` baut die drei Listen mit
   * `replaceChildren()` komplett neu, und der Hauptprozess schickt die Nutzlast
   * in jedem Zwei-Sekunden-Takt. Wer tippte, verlor seinen Satz, den Fokus und
   * die Schreibmarke, bevor er ihn zu Ende hatte. Der Takt zeichnet inzwischen
   * nur noch bei einer echten Aenderung (`onFreigaben`) -- DAS hier ist die
   * zweite Haelfte: es haelt den Satz auch dann, wenn wirklich etwas passiert,
   * waehrend jemand schreibt. Ohne diese Haelfte waere derselbe Fehler nur
   * seltener ausgeloest, nicht behoben.
   */
  const entwuerfe = new Map<string, string>();
  /** Dieselbe Sache fuer die Ergebniszeile -- sie gehoert zur selben Fehlerklasse. */
  const ergebnisse = new Map<string, { text: string; fehler: boolean }>();

  /**
   * Feld und Ergebniszeile eines Eintrags an seine Kennung binden: was von
   * vorhin da ist, wieder einsetzen, und jede Eingabe merken. `data-entwurf`
   * traegt die Kennung am Element selbst -- daran findet `zeichnen()` das Feld
   * nach dem Neubau wieder.
   */
  function feldBinden(eingabe: HTMLInputElement, ergebnis: HTMLDivElement, kennung: string): void {
    eingabe.dataset.entwurf = kennung;
    eingabe.value = entwuerfe.get(kennung) ?? '';
    eingabe.addEventListener('input', () => entwuerfe.set(kennung, eingabe.value));
    const vorher = ergebnisse.get(kennung);
    if (vorher) {
      ergebnis.textContent = vorher.text;
      ergebnis.classList.toggle('fg-fehler', vorher.fehler);
    }
  }

  /** Ergebniszeile setzen UND merken -- sonst waere sie nach dem naechsten Neubau weg. */
  function ergebnisSetzen(ergebnis: HTMLDivElement, kennung: string, text: string, fehler = false): void {
    ergebnis.textContent = text;
    ergebnis.classList.toggle('fg-fehler', fehler);
    ergebnisse.set(kennung, { text, fehler });
  }

  /** Wo die Schreibmarke gerade steht, bevor die Liste neu gebaut wird. */
  function fokusMerken(): { kennung: string; von: number; bis: number } | null {
    const aktiv = document.activeElement;
    if (!(aktiv instanceof HTMLInputElement) || !aktiv.classList.contains('fg-grund-eingabe')) return null;
    const kennung = aktiv.dataset.entwurf ?? '';
    if (!kennung) return null;
    return {
      kennung,
      von: aktiv.selectionStart ?? aktiv.value.length,
      bis: aktiv.selectionEnd ?? aktiv.value.length,
    };
  }

  /** Und wieder dorthin, nachdem sie neu gebaut wurde. Ist der Eintrag weg, bleibt es dabei. */
  function fokusZurueck(merk: { kennung: string; von: number; bis: number } | null): void {
    if (!merk) return;
    const feld = panel.querySelector<HTMLInputElement>(
      `.fg-grund-eingabe[data-entwurf="${CSS.escape(merk.kennung)}"]`,
    );
    if (!feld) return;
    feld.focus();
    feld.setSelectionRange(merk.von, merk.bis);
  }

  /**
   * Die Zeitangabe eines Eintrags haengt an der UHR, nicht an den Daten. Sie
   * traegt deshalb ihren Zeitpunkt am Element mit: bleibt die Nutzlast gleich,
   * wird nur sie aufgefrischt, statt die Liste neu zu bauen.
   */
  function wannBinden(el: HTMLElement, ms: number, praefix = ''): void {
    if (!Number.isFinite(ms) || !ms) return;
    el.dataset.wann = String(ms);
    if (praefix) el.dataset.wannPraefix = praefix;
  }

  function zeitenAuffrischen(): void {
    for (const el of panel.querySelectorAll<HTMLElement>('.fg-wann[data-wann]')) {
      el.textContent = `${el.dataset.wannPraefix ?? ''}${seitHerMs(Number(el.dataset.wann))}`;
    }
  }

  function schliessen(): void {
    offen = false;
    panel.classList.remove('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
  }

  function oeffnen(): void {
    offen = true;
    panel.classList.add('offen');
    // Die Buehne ist jetzt anders breit: melden, damit der Pane darauf passt.
    document.dispatchEvent(new CustomEvent('awb:flaeche-geaendert'));
    zeichnen();
  }

  registriere({ name: 'freigaben', offen: () => offen, oeffnen, schliessen });
  knopf.addEventListener('click', () => umschalten('freigaben'));
  panel.querySelector('.fg-schliessen')!.addEventListener('click', schliessen);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && offen) schliessen();
  });

  /**
   * Ein angehaltener Worker. Zwei Faelle in EINER Rubrik, weil es dieselbe
   * Sache ist: ein Worker steht und wartet. Bei `wartet` (mittlere Stufe)
   * kommen Annehmen/Ablehnen dazu, wie bei einem Antrag -- nur dann, weil bei
   * einer harten Ablehnung hier nichts zu entscheiden ist.
   */
  function zeileBlock(b: GuardBlockEntry): HTMLDivElement {
    const el = document.createElement('div');
    el.className = b.wartet ? 'fg-eintrag fg-block fg-block-wartet' : 'fg-eintrag fg-block';
    const wer = b.unbekannterPane ? `Pane ${b.pane} (keiner bekannten Session zugeordnet)` : b.workerName;
    el.innerHTML = `
      <div class="fg-eintrag-kopf">
        <span class="fg-wer">${wer}</span>
        <span class="fg-wann">${seitHer(b.ts)}</span>
      </div>
      <div class="fg-zusatz">${b.sessionName ? `${b.sessionName} &middot; ` : ''}${b.machine ? `${b.machine} &middot; ` : ''}Guard: ${b.guard}</div>
      <div class="fg-muster"></div>
      <div class="fg-grund"></div>
      <div class="fg-befehl"></div>
      <div class="fg-verzeichnis"></div>
      <div class="fg-aktionen"></div>
      <div class="fg-ergebnis"></div>`;
    wannBinden(el.querySelector<HTMLSpanElement>('.fg-wann')!, Date.parse(b.ts));
    const musterZeile = el.querySelector<HTMLDivElement>('.fg-muster')!;
    const grundZeile = el.querySelector<HTMLDivElement>('.fg-grund')!;
    if (b.wartet) {
      musterZeile.textContent = `Wartet auf Freigabe · Muster: ${b.muster}${b.musterGrund ? ` — ${b.musterGrund}` : ''}`;
      // Der volle Ablehnungstext gehoert dem WORKER -- er steht in dessen
      // Pane und sagt ihm, dass er wartet und den Befehl wiederholen soll.
      // Hier liest ihn ein Mensch, der entscheiden will; fuer ihn ist alles
      // Noetige schon da (Muster, Grund, Befehl, Verzeichnis). Am Belegbild
      // vom 05.08. schob die Textwand Annehmen und Ablehnen aus dem Bild --
      // ausgerechnet die zwei Knoepfe, fuer die es diese Stufe gibt.
      grundZeile.remove();
    } else {
      musterZeile.remove();
      grundZeile.textContent = b.reason;
    }
    el.querySelector('.fg-befehl')!.textContent = b.command;
    el.querySelector('.fg-verzeichnis')!.textContent = b.cwd;
    const aktionen = el.querySelector('.fg-aktionen')!;
    const ergebnis = el.querySelector<HTMLDivElement>('.fg-ergebnis')!;
    if (!b.unbekannterPane) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fg-btn';
      btn.textContent = 'Pane zeigen';
      btn.addEventListener('click', () => {
        window.awbBridge.bedienung('select', b.sessionId);
        window.awbBridge.bedienung('show-pane', b.pane);
        schliessen();
      });
      aktionen.appendChild(btn);
    }
    if (b.wartet) {
      // Die Kennung dieses Eintrags: der Schluessel ist derselbe Wert, ueber den
      // auch entschieden wird. Der Pfad ist nur der Rueckfall, falls einmal
      // keiner mitkommt -- ein Feld ohne Kennung behielte seinen Text nicht.
      const kennung = b.schluessel || b.path;
      const label = document.createElement('label');
      label.className = 'fg-grundfeld';
      // FREIWILLIG seit dem 19.08.: das Feld bleibt, der Zwang faellt. Steht
      // etwas darin, landet es im Verlauf; steht nichts darin, wird trotzdem
      // entschieden.
      label.textContent = 'Begruendung (freiwillig)';
      const eingabe = document.createElement('input');
      eingabe.type = 'text';
      eingabe.className = 'fg-grund-eingabe';
      eingabe.placeholder = 'optional -- ein Satz genuegt';
      label.appendChild(eingabe);
      feldBinden(eingabe, ergebnis, kennung);
      el.insertBefore(label, aktionen);

      const hinweis = document.createElement('div');
      hinweis.className = 'fg-hinweis';
      hinweis.textContent = 'Annehmen gilt fuer genau einen Durchlauf dieses Befehls und ist danach '
        + 'verbraucht. Der Worker fuehrt ihn selbst noch einmal aus; hier startet nichts.';
      el.insertBefore(hinweis, label);

      // `echt` ist `isTrusted` des Klicks und wird mitgeschickt, nicht hier
      // ausgewertet: erst der Hauptprozess entscheidet damit. Ein `el.click()`
      // aus einem Skript traegt false und gibt deshalb nichts frei -- eine
      // angehaltene Rueckfrage beantwortet nur ein Mensch.
      const entscheiden = (aktion: 'approve' | 'reject', echt: boolean): void => {
        const grund = eingabe.value.trim();
        window.awbBridge.bedienung('muster-entscheiden', {
          schluessel: b.schluessel, action: aktion, reason: grund, echt,
        });
        // Beim Annehmen wird nichts versprochen, was hier niemand weiss: die
        // Freigabe entsteht erst im Werkzeug, das die Herkunft misst. Bleibt
        // der Eintrag nach der Auffrischung stehen, hat es nicht geklappt --
        // der Grund steht dann im Verlauf darunter.
        ergebnisSetzen(ergebnis, kennung, aktion === 'approve'
          ? 'Freigabe erteilt -- der Eintrag verschwindet, sobald sie gilt; der Worker wiederholt den Befehl selbst.'
          : 'Abgelehnt -- der Befehl bleibt angehalten.');
      };
      const an = document.createElement('button');
      an.type = 'button';
      an.className = 'fg-btn fg-btn-an';
      an.textContent = 'Annehmen';
      an.addEventListener('click', (ev) => entscheiden('approve', ev.isTrusted));
      const ab = document.createElement('button');
      ab.type = 'button';
      ab.className = 'fg-btn fg-btn-ab';
      ab.textContent = 'Ablehnen';
      // Ablehnen braucht keinen Nachweis: es nimmt nichts weg, es laesst den
      // Befehl angehalten. Deshalb hier bewusst ohne `isTrusted`-Bedingung.
      ab.addEventListener('click', (ev) => entscheiden('reject', ev.isTrusted));
      aktionen.appendChild(an);
      aktionen.appendChild(ab);
    }
    return el;
  }

  /** V17: eine Gruppe (guard, reason) -- Zahl statt Einzelzeilen, das ist der Nutzen. */
  function zeileVerlauf(g: GuardLogGruppe): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'fg-eintrag fg-verlauf';
    el.innerHTML = `
      <div class="fg-eintrag-kopf">
        <span class="fg-wer">${g.guard}</span>
        <span class="fg-wann">${g.anzahl}&times; &middot; zuletzt ${seitHerMs(g.letzteMs)}</span>
      </div>
      <div class="fg-grund"></div>
      <div class="fg-befehl"></div>`;
    wannBinden(el.querySelector<HTMLSpanElement>('.fg-wann')!, g.letzteMs, `${g.anzahl}× · zuletzt `);
    el.querySelector('.fg-grund')!.textContent = g.reason;
    el.querySelector('.fg-befehl')!.textContent = g.letzterBefehl;
    return el;
  }

  function zeileRequest(r: RequestEntry): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'fg-eintrag fg-antrag';
    const modell = r.childEffort ? `${r.childModel}:${r.childEffort}` : r.childModel;
    el.innerHTML = `
      <div class="fg-eintrag-kopf">
        <span class="fg-wer">${r.parent} &rarr; ${r.childName}</span>
        <span class="fg-wann">${seitHer(r.ts)}</span>
      </div>
      <div class="fg-zusatz">${modell} &middot; ${r.dir}</div>
      <div class="fg-feld"><b>Aufgabe:</b> <span></span></div>
      <div class="fg-feld"><b>Warum abtrennbar:</b> <span></span></div>
      <div class="fg-feld"><b>Fertig-Kriterium:</b> <span></span></div>
      <div class="fg-feld"><b>Dateien:</b> <span></span></div>
      <div class="fg-feld"><b>Umfang:</b> <span></span></div>
      <div class="fg-hinweis">Annehmen heisst: der Orchestrator startet diesen Worker von Hand. Es spawnt hier nichts von selbst.</div>
      <label class="fg-grundfeld">Begruendung (freiwillig)
        <input type="text" class="fg-grund-eingabe" placeholder="optional -- ein Satz genuegt" />
      </label>
      <div class="fg-aktionen">
        <button type="button" class="fg-btn fg-btn-an">Annehmen</button>
        <button type="button" class="fg-btn fg-btn-ab">Ablehnen</button>
      </div>
      <div class="fg-ergebnis"></div>`;
    wannBinden(el.querySelector<HTMLSpanElement>('.fg-wann')!, Date.parse(r.ts));
    const felder = el.querySelectorAll('.fg-feld span');
    felder[0].textContent = r.task;
    felder[1].textContent = r.whySeparable;
    felder[2].textContent = r.doneCriterion;
    felder[3].textContent = r.files.join(', ');
    felder[4].textContent = r.est;
    const eingabe = el.querySelector<HTMLInputElement>('.fg-grund-eingabe')!;
    const ergebnis = el.querySelector<HTMLDivElement>('.fg-ergebnis')!;
    // Der Pfad des Antrags ist hier die stabile Kennung -- ueber ihn wird auch
    // entschieden. Die Begruendung ist freiwillig (19.08.), wie beim Block.
    feldBinden(eingabe, ergebnis, r.path);
    const entscheiden = (aktion: 'approve' | 'reject'): void => {
      const grund = eingabe.value.trim();
      window.awbBridge.bedienung('freigaben-entscheiden', { path: r.path, action: aktion, reason: grund });
      ergebnisSetzen(ergebnis, r.path,
        aktion === 'approve' ? 'Angenommen -- wird neu geladen …' : 'Abgelehnt -- wird neu geladen …');
    };
    el.querySelector('.fg-btn-an')!.addEventListener('click', () => entscheiden('approve'));
    el.querySelector('.fg-btn-ab')!.addEventListener('click', () => entscheiden('reject'));
    return el;
  }

  function zeichnen(): void {
    if (!offen) return;
    // Bevor die Listen fallen: wo stand die Schreibmarke? Der Text selbst
    // liegt schon in `entwuerfe` (jede Eingabe wird dort mitgeschrieben),
    // Fokus und Markierung dagegen haengen am Knoten und muessen hier ueber
    // den Neubau getragen werden.
    const merk = fokusMerken();
    listeBlocks.replaceChildren();
    if (!letzte.guardBlocks.length) {
      const leer = document.createElement('div');
      leer.className = 'fg-leer';
      leer.textContent = 'Kein Worker wartet gerade auf eine Guard-Entscheidung.';
      listeBlocks.appendChild(leer);
    } else {
      for (const b of letzte.guardBlocks) listeBlocks.appendChild(zeileBlock(b));
    }

    listeVerlauf.replaceChildren();
    if (!letzte.guardLog.length) {
      const leer = document.createElement('div');
      leer.className = 'fg-leer';
      leer.textContent = 'Noch keine Ablehnung aufgezeichnet.';
      listeVerlauf.appendChild(leer);
    } else {
      for (const g of letzte.guardLog) listeVerlauf.appendChild(zeileVerlauf(g));
    }

    listeRequests.replaceChildren();
    if (!letzte.requests.length) {
      const leer = document.createElement('div');
      leer.className = 'fg-leer';
      leer.textContent = 'Kein offener Antrag.';
      listeRequests.appendChild(leer);
    } else {
      for (const r of letzte.requests) listeRequests.appendChild(zeileRequest(r));
    }

    knopfEl.classList.toggle('fg-hat-wartende', letzte.guardBlocks.length > 0 || letzte.requests.length > 0);

    // Was nicht mehr in der Liste steht, braucht auch keinen Entwurf mehr --
    // sonst waechst die Karte ueber die Laufzeit des Fensters immer weiter.
    const lebende = new Set<string>([
      ...letzte.guardBlocks.map((b) => b.schluessel || b.path),
      ...letzte.requests.map((r) => r.path),
    ]);
    for (const k of [...entwuerfe.keys()]) if (!lebende.has(k)) entwuerfe.delete(k);
    for (const k of [...ergebnisse.keys()]) if (!lebende.has(k)) ergebnisse.delete(k);

    fokusZurueck(merk);
  }

  window.awbBridge.onFreigaben((p) => {
    const neu = p as FreigabenPayload;
    // DER TAKT (19.08.): der Hauptprozess schickt diese Nutzlast alle zwei
    // Sekunden -- auch dann, wenn sich nichts geaendert hat. Bis heute zeichnete
    // jede davon die Listen neu und riss dabei das Begruendungsfeld samt
    // getipptem Satz, Fokus und Schreibmarke aus dem Dokument; wer schrieb,
    // verlor seinen Satz nach spaetestens zwei Sekunden. Verglichen wird
    // deshalb die Nutzlast SELBST, und nur eine echte Aenderung zeichnet neu.
    //
    // Die Zeitangaben ("seit 3 Min.") haengen an der Uhr und nicht an den
    // Daten. Sie werden auch im ruhigen Fall aufgefrischt -- ohne Neubau, denn
    // sonst stuende die Anzeige still, solange sich nichts anderes bewegt.
    const signatur = JSON.stringify(neu);
    letzte = neu;
    if (signatur === letzteSignatur) {
      zeitenAuffrischen();
      return;
    }
    letzteSignatur = signatur;
    zeichnen();
  });
}
