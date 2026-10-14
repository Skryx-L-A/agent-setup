/**
 * KOPPLUNG (Spezifikation 4.1). Der Mac zeigt nach einem echten lokalen
 * Klick einen sechsstelligen Code; hier wird er eingegeben. Die App erzeugt
 * dabei einen nicht exportierbaren Schluessel (Paket 2) -- dieser Bildschirm
 * zeigt nur Ablauf, Eingabe und Fehler.
 */
import { geraetName } from './geraet';
import { h, neueId } from './dom';
import { seite, type Ansicht, type Umgebung } from './teile';

export function kopplungsAnsicht(u: Umgebung, imStapel: boolean): Ansicht {
  const stand = u.stand;
  const s = seite(u, { titel: 'Gerät koppeln', gross: true, zurueck: 'Gerät', klasse: 'kopplung-ansicht' });
  const codeId = neueId('code');
  const nameId = neueId('geraet');
  const code = h('input', {
    class: 'code-feld', id: codeId, type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6,
    autocomplete: 'one-time-code', 'aria-describedby': `${codeId}-hilfe`, placeholder: '000000',
  });
  const name = h('input', { class: 'feld', id: nameId, type: 'text', autocomplete: 'off', value: stand.kopplung?.geraet ?? geraetName() });
  const knopf = h('button', { class: 'knopf primaer breit', type: 'submit', disabled: true }, 'Koppeln');
  const fehler = h('p', { class: 'formular-fehler', role: 'alert', hidden: true });
  const erfolg = h('p', { class: 'formular-erfolg', role: 'status', hidden: true });
  const pruefen = (): void => { knopf.disabled = !/^\d{6}$/.test(code.value) || !name.value.trim(); };
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6);
    fehler.hidden = true;
    pruefen();
  });
  name.addEventListener('input', pruefen);
  const form = h('form', { class: 'formular kopplung-formular', novalidate: true },
    h('ol', { class: 'schritte' },
      h('li', null, h('span', { class: 'schritt-text' }, 'Starte am Mac in der Werkbank die Kopplung: Einstellungen, Maschinen, Mobilgerät, „Gerät koppeln“. Das geht nur dort, nicht aus der Ferne.')),
      h('li', null, h('span', { class: 'schritt-text' }, 'Gib hier den sechsstelligen Code ein, den der Mac zeigt. Er gilt zwei Minuten und erlaubt fünf Versuche.')),
    ),
    h('div', { class: 'formular-gruppe' },
      h('label', { class: 'formular-titel', for: codeId }, 'Code vom Mac'),
      h('div', { class: 'karte feldkarte code-karte' }, code),
      h('p', { class: 'formular-hilfe', id: `${codeId}-hilfe` }, 'Nur Ziffern. Der Code wird nirgends gespeichert.'),
    ),
    h('div', { class: 'formular-gruppe' },
      h('label', { class: 'formular-titel', for: nameId }, 'Name dieses Geräts'),
      h('div', { class: 'karte feldkarte' }, name),
    ),
    fehler,
    erfolg,
    knopf,
    h('p', { class: 'formular-notiz' }, 'Die App erzeugt dabei einen Schlüssel, der dieses Gerät nie verlässt. Jede Anfrage an Mac und peer wird damit signiert; ohne Kopplung nimmt die Werkbank nichts an.'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (knopf.disabled) return;
    knopf.disabled = true;
    knopf.textContent = 'Koppelt …';
    const r = await stand.koppeln(code.value, name.value.trim());
    knopf.textContent = 'Koppeln';
    if (r.ok) {
      erfolg.hidden = false;
      erfolg.textContent = 'Gekoppelt. Die Werkbank kennt dieses Gerät jetzt.';
      if (imStapel) window.setTimeout(() => u.router.zurueck(), 900);
    } else {
      fehler.hidden = false;
      fehler.textContent = r.fehler.message;
      code.select();
      pruefen();
    }
  });
  s.inhalt.append(form);
  if (!imStapel) s.el.classList.add('vollbild');
  pruefen();
  return { el: s.el, aktualisieren: () => undefined };
}
