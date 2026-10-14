/**
 * DER GERAETESPEICHER DER PWA (Spezifikation 4.1 Punkt 1).
 *
 * Der private `CryptoKey` liegt per Structured Clone in IndexedDB -- nie als
 * JWK, PKCS8 oder Rohbytes. Verliert iOS die Datenbank, faellt die App auf
 * „nicht gekoppelt" zurueck; es gibt keinen Wiederherstellungsweg.
 *
 * Daneben je Origin der Requestzaehler (monoton, vor dem Senden gespeichert)
 * und die ID des Push-Abos, das dieses Geraet dort registriert hat.
 */

export interface GeraeteStand {
  readonly device_id: string;
  readonly key_id: string;
  readonly device_name: string;
  readonly paired_at: number;
  /** Nicht exportierbar; nur zum Signieren. */
  readonly privat: CryptoKey;
}

export interface GeraeteSpeicher {
  laden(): Promise<GeraeteStand | null>;
  speichern(stand: GeraeteStand): Promise<void>;
  loeschen(): Promise<void>;
  /** Schreib-/Leseprobe: wirft, wenn der Speicher nicht arbeitet. Die Kopplung prueft damit, bevor ein Schluessel den Server erreicht. */
  pruefen(): Promise<void>;
  /**
   * Der naechste Zaehler fuer eine Origin: `max(letzter + 1, jetzt)`. Die Uhr als
   * Untergrenze haelt ihn auch dann monoton, wenn zwei Fenster derselben App
   * gleichzeitig signieren oder ein Schreibvorgang verloren ging.
   */
  naechsterZaehler(origin: string, jetzt: number): Promise<number>;
  pushAbos(): Promise<Record<string, string>>;
  pushAboSetzen(origin: string, id: string | null): Promise<void>;
}

/** Fuer Node-Proben und die Attrappe: derselbe Vertrag ohne Persistenz. */
export class FluechtigerSpeicher implements GeraeteSpeicher {
  private stand: GeraeteStand | null = null;
  private zaehler = new Map<string, number>();
  private abos: Record<string, string> = {};

  async laden(): Promise<GeraeteStand | null> { return this.stand; }
  async speichern(stand: GeraeteStand): Promise<void> { this.stand = stand; }
  async loeschen(): Promise<void> { this.stand = null; this.zaehler.clear(); this.abos = {}; }
  async pruefen(): Promise<void> { /* ohne Persistenz gibt es nichts zu pruefen */ }
  async naechsterZaehler(origin: string, jetzt: number): Promise<number> {
    const n = Math.max((this.zaehler.get(origin) ?? 0) + 1, jetzt);
    this.zaehler.set(origin, n);
    return n;
  }
  async pushAbos(): Promise<Record<string, string>> { return { ...this.abos }; }
  async pushAboSetzen(origin: string, id: string | null): Promise<void> {
    if (id) this.abos[origin] = id;
    else delete this.abos[origin];
  }
}

const DB = 'awb-mobil';
const GERAET = 'geraet';
const ZAEHLER = 'zaehler';
const ABOS = 'abos';
const PRUEFSCHLUESSEL = 'probe';
const PRUEFWERT = 'ok';

/** So lange darf ein Versuch (Oeffnen und Operation zusammen) dauern; danach gilt die Verbindung als tot. */
export const SPEICHER_FRIST_MS = 5_000;

/** Der Geraetespeicher antwortet auch nach einem frischen Versuch nicht. */
export class SpeicherFehler extends Error {
  constructor(message: string, readonly ursache?: unknown) {
    super(message);
    this.name = 'SpeicherFehler';
  }
}

class Zeitueberschreitung extends Error {}
/** Das Oeffnen selbst ist gescheitert (auch das lohnt eine Wiederholung). */
class OeffnenFehler extends Error {}

/**
 * Hat iOS die Verbindung zum IndexedDB-Server gekappt (Web-App lange im
 * Hintergrund), werfen alle Transaktionen auf ihr: `InvalidStateError`,
 * „Connection to Indexed Database server lost", abgebrochene Transaktionen.
 * Nur das lohnt eine frische Verbindung; ein `DataError` o. ae. ist ein Fehler im Aufruf.
 */
function verbindungsFehler(e: unknown): boolean {
  if (e instanceof Zeitueberschreitung || e instanceof OeffnenFehler) return true;
  const name = (e as { name?: unknown } | null)?.name;
  const text = String((e as { message?: unknown } | null)?.message ?? '');
  return name === 'InvalidStateError' || name === 'UnknownError' || name === 'AbortError'
    || name === 'TransactionInactiveError' || /connection|lost|closing|closed/i.test(text);
}

function anfrage<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, fehler) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fehler(r.error ?? new Error('IndexedDB-Anfrage gescheitert'));
  });
}

/**
 * Eine Transaktion, die erst mit `complete` gilt (nicht schon mit der Antwort
 * der letzten Anfrage): ein Abbruch danach faellt so auf, bevor der Zaehler
 * als vergeben gilt.
 */
function transaktion<T>(db: IDBDatabase, store: string, art: IDBTransactionMode, tun: (s: IDBObjectStore) => Promise<T>): Promise<T> {
  return new Promise<T>((ok, nein) => {
    const tx = db.transaction(store, art);
    let wert: T;
    let fertig = false;
    let beendet = false;
    const pruefen = (): void => { if (fertig && beendet) ok(wert); };
    tx.oncomplete = () => { beendet = true; pruefen(); };
    tx.onabort = () => nein(tx.error ?? new DOMException('Transaktion abgebrochen', 'AbortError'));
    tx.onerror = () => { /* der Abbruch folgt und meldet den Fehler */ };
    tun(tx.objectStore(store)).then((w) => { wert = w; fertig = true; pruefen(); }, (e) => {
      nein(e);
      try { tx.abort(); } catch { /* schon beendet */ }
    });
  });
}

/** Zeitgeber der Frist; eine reine Testnaht (Vorgabe `setTimeout`/`clearTimeout`, im Betrieb unveraendert). */
export interface Zeitgeber {
  setzen(fn: () => void, ms: number): unknown;
  loeschen(h: unknown): void;
}

const ECHTER_ZEITGEBER: Zeitgeber = {
  setzen: (fn, ms) => setTimeout(fn, ms),
  loeschen: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SpeicherOptionen {
  readonly frist?: number;
  readonly uhr?: Zeitgeber;
  readonly fabrik?: IDBFactory;
}

export class IndexedDbSpeicher implements GeraeteSpeicher {
  private db: Promise<IDBDatabase> | null = null;
  private aktuell: IDBDatabase | null = null;
  private readonly frist: number;
  private readonly uhr: Zeitgeber;
  private readonly fabrik: IDBFactory | null;

  constructor(opt: SpeicherOptionen = {}) {
    this.frist = opt.frist ?? SPEICHER_FRIST_MS;
    this.uhr = opt.uhr ?? ECHTER_ZEITGEBER;
    this.fabrik = opt.fabrik ?? null;
  }

  /** Verbindung wegwerfen (auch eine noch offene); die naechste Operation oeffnet frisch. */
  private verwerfen(d?: IDBDatabase | null): void {
    if (!d || d === this.aktuell) {
      const alt = this.aktuell;
      this.aktuell = null;
      this.db = null;
      if (alt) try { alt.close(); } catch { /* schon zu */ }
    }
    if (d) try { d.close(); } catch { /* schon zu */ }
  }

  private oeffnen(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const p: Promise<IDBDatabase> = new Promise((ok, fehler) => {
      let r: IDBOpenDBRequest;
      try { r = (this.fabrik ?? indexedDB).open(DB, 1); } catch (e) { fehler(new OeffnenFehler(String((e as Error)?.message ?? e))); return; }
      r.onupgradeneeded = () => {
        for (const name of [GERAET, ZAEHLER, ABOS]) {
          if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
        }
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => this.verwerfen(d);
        d.onversionchange = () => this.verwerfen(d);
        // Kam die Verbindung erst nach einer Frist zustande, gehoert sie niemandem mehr.
        if (this.db !== p) { try { d.close(); } catch { /* schon zu */ } fehler(new Zeitueberschreitung('verworfen')); return; }
        this.aktuell = d;
        ok(d);
      };
      r.onerror = () => fehler(new OeffnenFehler(r.error?.message ?? 'IndexedDB nicht verfügbar'));
    });
    this.db = p;
    // Ein abgelehntes Oeffnen bleibt nicht fuer immer abgelehnt.
    p.catch(() => { if (this.db === p) this.db = null; });
    return p;
  }

  /** Ein Versuch unter Frist: oeffnen (falls noetig) und die Operation. */
  private versuch<T>(tun: (db: IDBDatabase) => Promise<T>): Promise<T> {
    return new Promise<T>((ok, nein) => {
      const uhr = this.uhr.setzen(() => nein(new Zeitueberschreitung('IndexedDB antwortet nicht')), this.frist);
      let fertig: Promise<T>;
      try { fertig = this.oeffnen().then(tun); } catch (e) { fertig = Promise.reject(e); }
      fertig.then(ok, nein).finally(() => this.uhr.loeschen(uhr));
    });
  }

  /** Bei Verbindungsfehler oder Frist EINMAL mit frisch geoeffneter Verbindung wiederholen. */
  private async mitWiederholung<T>(tun: (db: IDBDatabase) => Promise<T>): Promise<T> {
    let letzter: unknown;
    for (let n = 0; n < 2; n += 1) {
      try {
        return await this.versuch(tun);
      } catch (e) {
        if (!verbindungsFehler(e)) throw e;
        letzter = e;
        this.verwerfen();
      }
    }
    throw new SpeicherFehler('Der Geräte-Speicher antwortet nicht.', letzter);
  }

  private lauf<T>(store: string, art: IDBTransactionMode, tun: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.mitWiederholung((db) => transaktion(db, store, art, (s) => anfrage(tun(s))));
  }

  async laden(): Promise<GeraeteStand | null> {
    const wert = await this.lauf(GERAET, 'readonly', (s) => s.get('stand')) as GeraeteStand | undefined;
    return wert && wert.privat instanceof CryptoKey ? wert : null;
  }

  async speichern(stand: GeraeteStand): Promise<void> {
    await this.lauf(GERAET, 'readwrite', (s) => s.put(stand, 'stand'));
  }

  async loeschen(): Promise<void> {
    for (const store of [GERAET, ZAEHLER, ABOS]) await this.lauf(store, 'readwrite', (s) => s.clear());
  }

  async pruefen(): Promise<void> {
    // Eigener Schluessel im Geraete-Store, der nach der Probe wieder weg ist; `stand` bleibt unberuehrt.
    let gelesen: unknown;
    await this.mitWiederholung((db) => transaktion(db, GERAET, 'readwrite', async (s) => {
      await anfrage(s.put(PRUEFWERT, PRUEFSCHLUESSEL));
      gelesen = await anfrage(s.get(PRUEFSCHLUESSEL));
      await anfrage(s.delete(PRUEFSCHLUESSEL));
    }));
    if (gelesen !== PRUEFWERT) throw new SpeicherFehler('Der Geräte-Speicher antwortet nicht.', gelesen);
  }

  async naechsterZaehler(origin: string, jetzt: number): Promise<number> {
    // Vergeben ist der Zaehler erst, wenn die Transaktion abgeschlossen ist; ein
    // Fehlversuch hat nichts geschrieben, die Wiederholung rechnet neu und liegt
    // durch die Uhr mindestens auf `jetzt`.
    return this.mitWiederholung((db) => transaktion(db, ZAEHLER, 'readwrite', async (s) => {
      const alt = Number(await anfrage(s.get(origin)) ?? 0);
      const neu = Math.max((Number.isSafeInteger(alt) ? alt : 0) + 1, jetzt);
      await anfrage(s.put(neu, origin));
      return neu;
    }));
  }

  async pushAbos(): Promise<Record<string, string>> {
    const wert = await this.lauf(ABOS, 'readonly', (s) => s.get('abos')) as Record<string, string> | undefined;
    return { ...(wert ?? {}) };
  }

  async pushAboSetzen(origin: string, id: string | null): Promise<void> {
    // Lesen und Schreiben in EINER Transaktion, damit zwei Aufrufe sich nicht ueberschreiben.
    await this.mitWiederholung((db) => transaktion(db, ABOS, 'readwrite', async (s) => {
      const abos = { ...((await anfrage(s.get('abos')) as Record<string, string> | undefined) ?? {}) };
      if (id) abos[origin] = id;
      else delete abos[origin];
      await anfrage(s.put(abos, 'abos'));
    }));
  }
}
