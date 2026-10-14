/**
 * NEUE SITZUNG als Blatt: Maschine, Ordner, Name, Harness, Modell.
 * Gestartet wird ueber `POST /sessions`, das im Kern `sessionAnlegen()`
 * aufruft (Spezifikation 3.1); Pfad, Ausschluesse und Doppelstarts prueft der
 * Kern, nicht die App.
 */
import type { StartOptionen } from './quelle';
import { ersetzen, h, neueId } from './dom';
import { maschinenName, navTextKnopf, seite, type Ansicht, type Umgebung } from './teile';

function segmente<T extends string>(name: string, werte: { wert: T; text: string; aus?: boolean }[], gewaehlt: T, bei: (w: T) => void): HTMLElement {
  const gruppe = h('div', { class: 'segmente', role: 'radiogroup', 'aria-label': name });
  const gruppenName = neueId(name);
  for (const w of werte) {
    const id = neueId('seg');
    const eingabe = h('input', { type: 'radio', name: gruppenName, id, value: w.wert, checked: w.wert === gewaehlt, disabled: w.aus === true });
    eingabe.addEventListener('change', () => { if (eingabe.checked) bei(w.wert); });
    gruppe.append(h('label', { class: 'segment', for: id }, eingabe, h('span', null, w.text)));
  }
  return gruppe;
}

export function neueSitzung(u: Umgebung): Ansicht {
  const stand = u.stand;
  const starten = navTextKnopf('Starten', () => { void absenden(); }, true);
  const abbrechen = navTextKnopf('Abbrechen', () => u.router.zurueck());
  const s = seite({ ...u, tiefe: 0 }, { titel: 'Neue Sitzung', aktionen: [starten], klasse: 'blatt-ansicht' });
  s.nav.querySelector('.nav-links')?.replaceChildren(abbrechen);
  const form = h('form', { class: 'formular', novalidate: true });
  form.addEventListener('submit', (e) => { e.preventDefault(); void absenden(); });
  s.inhalt.append(form);

  let maschine = stand.maschinen.find((m) => m.erreichbar)?.machine ?? 'mac';
  let harness = 'claude';
  let modell = '';
  let nameVonHand = false;
  const ordner = h('input', { class: 'feld', type: 'text', inputmode: 'url', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', placeholder: '/Users/me/AI/projekt', 'aria-label': 'Ordner (absoluter Pfad)', id: neueId('ordner') });
  const name = h('input', { class: 'feld', type: 'text', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', placeholder: 'Name der Sitzung', 'aria-label': 'Name der Sitzung', id: neueId('name') });
  const fehler = h('p', { class: 'formular-fehler', role: 'alert', hidden: true });
  const vorschlaege = h('div', { class: 'vorschlaege', role: 'list', 'aria-label': 'Zuletzt benutzte Ordner' });
  const maschinenFeld = h('div');
  const harnessFeld = h('div');
  const modellFeld = h('div', { class: 'auswahl-liste', role: 'radiogroup', 'aria-label': 'Modell' });

  const pruefen = (): void => {
    starten.disabled = !stand.darfSchreiben() || !ordner.value.startsWith('/') || !name.value.trim() || !modell;
  };
  const nameAusOrdner = (): void => {
    if (nameVonHand) return;
    const teile = ordner.value.replace(/\/+$/, '').split('/');
    name.value = teile[teile.length - 1] ?? '';
  };
  ordner.addEventListener('input', () => { nameAusOrdner(); pruefen(); });
  name.addEventListener('input', () => { nameVonHand = name.value.trim() !== ''; pruefen(); });

  const zeichnen = (o: StartOptionen | null): void => {
    ersetzen(maschinenFeld, segmente('Maschine', stand.maschinen.map((m) => ({
      wert: m.machine, text: m.erreichbar ? maschinenName(m.machine) : `${maschinenName(m.machine)} (offline)`, aus: !m.erreichbar,
    })), maschine, (w) => { maschine = w; zeichnen(o); }));
    const passend = (o?.ordner ?? []).filter((p) => (maschine === 'mac' ? p.startsWith('/Users/') : p.startsWith('/home/')));
    ersetzen(vorschlaege, ...passend.map((p) => h('button', { class: 'vorschlag', type: 'button', role: 'listitem', onclick: () => { ordner.value = p; nameVonHand = false; nameAusOrdner(); pruefen(); } }, p)));
    const harnesses = o?.harnesses ?? [];
    ersetzen(harnessFeld, segmente('Harness', harnesses.map((x) => ({ wert: x.id, text: x.name })), harness, (w) => {
      harness = w;
      modell = harnesses.find((x) => x.id === w)?.modelle[0]?.id ?? '';
      zeichnen(o);
    }));
    const modelle = harnesses.find((x) => x.id === harness)?.modelle ?? [];
    if (!modell || !modelle.some((m) => m.id === modell)) modell = modelle[0]?.id ?? '';
    ersetzen(modellFeld, ...modelle.map((m) => {
      const id = neueId('modell');
      const eingabe = h('input', { type: 'radio', name: 'modell', id, value: m.id, checked: m.id === modell });
      eingabe.addEventListener('change', () => { modell = m.id; pruefen(); });
      return h('label', { class: 'auswahl', for: id }, eingabe, h('span', { class: 'auswahl-text' }, h('span', null, m.name), h('span', { class: 'auswahl-id' }, m.id)));
    }));
    pruefen();
  };

  form.append(
    h('div', { class: 'formular-gruppe' }, h('span', { class: 'formular-titel' }, 'Maschine'), maschinenFeld),
    h('div', { class: 'formular-gruppe' },
      h('label', { class: 'formular-titel', for: ordner.id }, 'Ordner'),
      h('div', { class: 'karte feldkarte' }, ordner),
      vorschlaege,
    ),
    h('div', { class: 'formular-gruppe' },
      h('label', { class: 'formular-titel', for: name.id }, 'Name'),
      h('div', { class: 'karte feldkarte' }, name),
    ),
    h('div', { class: 'formular-gruppe' }, h('span', { class: 'formular-titel' }, 'Harness'), harnessFeld),
    h('div', { class: 'formular-gruppe' }, h('span', { class: 'formular-titel' }, 'Modell'), h('div', { class: 'karte' }, modellFeld)),
    fehler,
    h('p', { class: 'formular-notiz' }, 'Die Werkbank prüft Ordner, Ausschlüsse und laufende Sitzungen selbst. Bis der Mobilbeleg den Startweg erreicht, gilt die Effort-Grenze für Starts, die nicht vom Menschen am Rechner kommen.'),
  );

  zeichnen(stand.startOptionen);
  if (!stand.startOptionen) void stand.optionenLaden().then(zeichnen);

  const absenden = async (): Promise<void> => {
    if (starten.disabled) return;
    starten.disabled = true;
    const r = await stand.anlegen({ directory: ordner.value.trim(), name: name.value.trim(), machine: maschine, harness, model: modell });
    if (r.ok) {
      u.router.ersetzen({ tab: 'sitzungen', ansicht: 'chat', id: r.data.session.id });
    } else {
      fehler.hidden = false;
      fehler.textContent = r.fehler.message;
      pruefen();
    }
  };

  return { el: s.el, aktualisieren: pruefen };
}
