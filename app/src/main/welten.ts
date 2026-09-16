// DIE WELTEN DER AGENTS (14.09.2026, Plan Fassung 28, Abschnitt 6; Auftrag
// agentsui). Diese Datei sammelt, was die Agents-Ansicht beider Oberflaechen
// je Welt zeichnet: Hauptagent, Teams, Mitglieder mit Zustand, Tickets, Kanal,
// Direktchats, Einzelchats und Fragen -- und fuehrt die Handlungen des Menschen
// aus (Nachricht senden, Frage beantworten oder zuruecknehmen, Pause, Stopp,
// neues Ticket).
//
// EIN SCHREIBER. Gelesen und geschrieben wird ausschliesslich ueber die
// Datenbibliothek `shell/agents_data.py`, und zwar ueber ihren eigenen
// Einstiegspunkt (`agents_data.py welt|agent|ticket|kanal …`, dieselben Wege
// wie `wb-welt`, `wb-agent`, `wb-ticket`, `wb-kanal`). Die Befehle selbst
// stehen NICHT im PATH-Aufruf: das installierte `wb-agent` ist bis zur
// Auslieferung noch der alte Pane-Start (Stand 14.09., ~/.local/bin/wb-agent
// vom 05.09.) und liest keine Argumente -- ein `wb-agent pause` aus dem Kern
// wuerde laut Quelltext einen Claude-Pane in der laufenden tmux-Sitzung
// oeffnen (gelesen, nicht ausgefuehrt). Gelesen wird mit `wb-welt finden` und `wb-welt
// ansicht`; beide schreiben nie.
//
// DER ABSENDER. Die Oberflaeche schreibt als `mensch`, ein Steuerkanal und ein
// nachgestellter Klick als `cli-operator`. Beides ist Metadatum, kein Beleg:
// die Bibliothek speichert `verified: false`, und eine Herkunftspruefung
// erfindet diese Datei nicht (Plan Abschnitt 13, „Rechte und Freigaben").
//
// DER MENSCH DER WELT (Auftrag agentsui Nr. 2) heisst in den Daten `mensch`:
// Agenten schreiben ihm im Kanal und im Einzelchat, ohne jemanden zu wecken;
// „braucht dich" zaehlt davon nur, was als Frage oder Ergebnis markiert und noch
// nicht quittiert ist. Sein Lesestand liegt in der Welt (`menschen/mensch/
// gelesen.json`), damit Mac und Electron dieselben Ungelesen-Zahlen zeigen.
//
// AGENTEN ANLEGEN (Auftrag agentsui Nr. 3): Vorlagen aus `agents/bibliothek/`
// und die Modellliste aus `wb-state models table` reisen in der Nutzlast; ein
// Vorschlag per Modell laeuft ueber agentenentwurf.ts, geprueft und angelegt
// wird ueber die Bibliothek (`agent entwurf`, `agent anlegen`). Antraege von
// Teamleitern sind Fragen an den Hauptagenten (`kind: agent-antrag`); sie
// zaehlen nicht als Frage an den Menschen und stehen unter `antraege`.
// Der zweite Weg zum Entwurf ist das Gespraech (Auftrag agentschat, agentengespraech.ts):
// `welt:gespraech` fuehrt je Welt einen Verlauf im Speicher und mischt jeden Zug in den
// Entwurf des Formulars; `verwerfen`, `neu` und ein erfolgreiches Anlegen loeschen ihn.
//
// SKILLS (Auftrag agentsui Nr. 4): je Welt ein zweiter, nur lesender Aufruf
// `agents_skills_ansicht.py <welt> --json` neben der Bibliothek. Er liefert je Agent
// Skills mit `SKILL.md`, Skill-Verlauf und Tokenmessung je Ticketart, je Ticket
// „Skill-Vorschlag" den Diff. Abnehmen und Ablehnen gehen ueber `agents_skills.py`
// (`wb-skill abnehmen|ablehnen`). Faellt der Skill-Aufruf aus, bleibt die Welt lesbar
// und nennt den Grund in `skills_fehler`.
//
// WELTEN ANLEGEN (Auftrag agentsux Nr. 1): `welt:neu {"art":"projekt","ordner":…}` oder
// `{"art":"global"}` legt eine Welt ueber `agents_data.py welt neu … --ohne-hauptagent` an;
// den Hauptagenten legt der Mensch danach im Anlege-Menue an, selbst oder als Vorschlag.
// Eine Projektwelt ausserhalb der Wurzeln (`~/AI`) und ohne laufende Sitzung faende
// `welt finden` nie wieder; ihr Ordner wird deshalb in `welten-projekte.json` im
// Zustandsordner des Programms gemerkt und bei jedem Finden als `--projekt` mitgegeben.
//
// FERNWELTEN (Auftrag fernwelten, 15.09.2026): eine Welt hat ihre Ablage auf dieser Maschine oder auf
// einer Agent-Maschine (`agents.maschinen`, Vorgabe peer). Eine Fernwelt heisst in der Nutzlast
// `<maschine>:<ablage>` und traegt `maschine`, `fern`, `ablage`, `verbindung` und `traeger`. Gefunden wird
// sie im Register `welten-fern.json` (eingetragen von `welt:neu` mit Maschine und von `wb-welt umziehen`)
// und mit `welt finden` auf jeder Maschine, die dort eine Welt hat; gelesen im eigenen Takt (die
// gewaehlte alle `AWB_WELTEN_FERN_TAKT_MS`, sonst `nachlesenMs`), ohne dass der Takt des Kerns wartet;
// geschrieben mit denselben Aufrufen der Datenbibliothek, nur ueber ssh (fernwelten.ts,
// shell/agents_weltauftrag.py). Nach jedem Schreiben, das eine Zustellung erzeugt, weckt der Kern den
// Traeger der Welt, fern wie lokal, wenn sie eine `traeger.json` hat.
//
// WAS DIE DATEN NICHT HERGEBEN, steht nicht da. Ohne Traeger heisst „arbeitet": ein
// Ticket dieses Agenten steht auf „läuft". Das Zugprotokoll mit Werkzeugaufrufen gibt
// es in den Weltdateien noch nicht.
//
// DAS LEBENSZEICHEN (Auftrag agentaktiv, 15.09.2026). Hat die Welt einen Traeger
// (`traeger.json`), liest jede Lesung einmal `agents_traeger.py status --nur-zug` -- fern
// ueber `agents_weltauftrag.py lesen`, lokal direkt -- und traegt je Agent `zug` (laeuft,
// seit, Art, offene Zustellung, Grund, naechster Wecker, letzter Zug), `leben` (arbeitet,
// wartet, schlaeft, nicht erreichbar) und `antwort` (der Stand unter der eigenen, noch
// unbeantworteten Nachricht im Einzelchat) in die Nutzlast. Mit Traeger heisst „arbeitet"
// dann: ein Zug laeuft. Ohne Traeger bleiben alle drei null. Die 30 Sekunden bis „Träger
// hat den Zug nicht gestartet" und die laufende Uhr „arbeitet seit 0:12" rechnen die
// Oberflaechen selbst; der Kern liefert dafuer nur Zeiten, damit die Nutzlast nicht jede
// Sekunde anders aussieht.
//
// RECHTE UND MODELLE (Auftrag agentsform, 16.09.2026; alice: „Der Hauptagent darf entscheiden, wer
// welche Berechtigung bekommt, und ich beim Erstellen."). Je Welt reisen `modelle` und `maschine_vorgabe`
// aus `wb-welt ansicht` (Worker agentrechte; fehlt das Feld, bleibt `modelle` null und die Oberflaechen
// nehmen die Registry), der Skillkatalog der Welt und der Bibliothek, ob es einen Zugang der Art `web`
// gibt und ob die Bibliothek `agent rechte` kennt. `welt:rechte` ruft `wb-agent rechte <agent>
// --werkzeuge … --bash … --skills …`; die Form der Listen liest der Kern aus der Hilfe des Unterbefehls
// und prueft nach dem Schreiben, ob das Profil sie traegt. `welt:vergessen` nimmt einen gemerkten
// Projektordner aus `welten-projekte.json`, ohne den Ordner anzufassen.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  FernWeg, fernOptionenAusUmgebung, fernSchluessel, fernSchluesselLesen, homeRelativ, registerEintragen, registerLesen,
  type FernOptionen, type MaschinenAngabe,
} from './fernwelten';

import {
  ENTWURF_FELDER, ENTWURF_MODELLE, entwurfAbraeumen, entwurfAusText, entwurfOptionenAusUmgebung, entwurfPrompt,
  modelleAusTabelle, modellWaehlen, vorschlagLaufen, type EntwurfOptionen, type ModellWahl, type ModellZeile, type VorschlagErgebnis,
} from './agentenentwurf';
import {
  GESPRAECH_GRENZEN, GESPRAECH_SYSTEM, GespraechSpeicher, antwortTrennen, blockLesen, entwurfsFelder, gespraechMischen, gespraechPrompt,
  type GespraechZug,
} from './agentengespraech';

export type { GespraechZug } from './agentengespraech';

export interface Lauf { code: number | null; out: string; err: string; fehler: string }
export type Laeufer = (bin: string, args: string[], fristMs: number) => Promise<Lauf>;

/** Wer ausserhalb der Welt steht (agents_data.py, HUMAN_ACTORS). */
export const MENSCHEN = ['mensch', 'alice', 'companion', 'orchestrator', 'cli-operator'];
/** Der eine Mensch einer Welt, dem Agenten schreiben (agents_data.py, WORLD_HUMAN). */
export const WELT_MENSCH = 'mensch';

// ---------------------------------------------------------------------------
// Rohformen von `wb-welt finden --json` und `wb-welt ansicht --json`
// ---------------------------------------------------------------------------
export interface RohFund {
  path: string; kind: string; project: string | null; id: string | null; name: string | null; state: string | null; error: string | null;
  /** Nur bei einer Fernwelt: die Maschine, auf der `path` liegt. */
  maschine?: string;
}
interface RohText { text?: string | null; truncated?: boolean; modified_at?: string | null }
export interface RohAgent {
  id: string; name?: string; stage?: string; team?: string | null; specialty?: string;
  figure?: unknown; tools?: string[]; skills?: string[]; machine?: string; state?: string;
  bash?: string[]; context_limit?: string; template?: string | null; created_by?: { id?: string } | null;
  created_at?: string; updated_at?: string;
  model_profile?: { model?: string; effort?: string; fallback_model?: string | null; fallback_effort?: string | null };
  runtime?: { state?: string; updated_at?: string; reason?: string | null };
  postbox?: { open?: number; total?: number };
  memory?: RohText & { sha256?: string }; instructions?: RohText;
  history?: { entries?: unknown[]; total?: number };
}
export interface RohEreignis { id?: string; time?: string; event?: string; actor?: { id?: string }; note?: string | null; reason?: string; assignee?: string; commit?: string | null }
export interface RohTicket {
  id: string; title?: string; goal?: string; done_criterion?: string; limits?: Record<string, unknown>;
  dependencies?: string[]; recipients?: string[]; team?: string | null; sender?: string; state?: string;
  assignee?: string | null; claimed_at?: string | null;
  result?: { text?: string; commit?: string | null; agent?: string; written_at?: string } | null;
  approval?: { agent?: string; time?: string; note?: string | null } | null;
  created_at?: string; updated_at?: string;
  history?: { events?: RohEreignis[]; total?: number };
}
export interface RohNachricht { id: string; kind?: string; sender?: string; recipient?: string | null; recipients?: string[]; humans?: string[]; mark?: string | null; subject?: string; ticket?: string | null; text?: string; time?: string }
export interface RohZustellung extends RohNachricht { delivery_id?: string; acknowledged?: boolean }
export interface RohMensch { postbox?: { open?: number; total?: number; deliveries?: RohZustellung[] }; read_state?: Record<string, { time?: string; id?: string }> }
export interface RohFrage {
  id: string; text?: string; options?: string[]; recommendation?: string | null; ticket?: string | null; state?: string;
  sender?: string; created_at?: string;
  /** `agent-antrag`: Antrag eines Teamleiters an den Hauptagenten (`to`), mit dem Entwurf. */
  kind?: string; to?: string; draft?: { id?: string; team?: string | null; specialty?: string; stage?: string };
  answer?: { text?: string; sender?: string; answered_at?: string; note?: string | null; agent?: string | null } | null;
  withdrawal?: { reason?: string | null; sender?: string; withdrawn_at?: string } | null;
}
export interface RohAnsicht {
  path: string; consistent?: boolean; read_at?: string;
  world: { id?: string; name?: string; kind?: string; state?: string; created_at?: string; updated_at?: string;
    pause?: { changed_at?: string; reason?: string | null }; stop?: { changed_at?: string; reason?: string | null } };
  agents?: RohAgent[]; tickets?: RohTicket[]; channel?: RohNachricht[]; channel_total?: number;
  direct_chats?: { id: string; participants?: string[]; messages?: RohNachricht[]; total?: number }[];
  questions?: RohFrage[]; humans?: Record<string, RohMensch>; errors?: { section?: string; text?: string }[];
  /** Zugaenge der Welt (`zugaenge.json`): nur Name und Art, nie Ziel oder Schluesselpfad. */
  zugaenge?: { name?: string; art?: string }[];
  /** Auftrag agentsform (Feld vom Worker agentrechte): die Modelle, die der Traeger dieser Welt fahren kann. */
  modelle?: unknown;
  /** Auftrag agentsform (Feld vom Worker agentrechte): die Maschine eines neuen Agenten, die Traegermaschine der Welt. */
  maschine_vorgabe?: unknown;
}

// ---------------------------------------------------------------------------
// Die Nutzlast (additiv in `awb:aufgaben` als Feld `welten`)
// ---------------------------------------------------------------------------
export type AgentZustand = 'braucht_dich' | 'arbeitet' | 'hat_ergebnis' | 'wartet' | 'schlaeft' | 'pausiert' | 'gestoppt' | 'archiviert';

export interface WeltNachricht {
  id: string; art: string; von: string; an: string[]; text: string; zeit: string;
  ticket: string | null; betreff: string; von_mensch: boolean;
  /** `frage` oder `ergebnis` an den Menschen, sonst null. */
  markierung: string | null;
  /** An den Menschen zugestellt und von ihm noch nicht quittiert. */
  offen_fuer_mensch: boolean;
}
export interface ChatEintrag { art: 'nachricht' | 'frage'; id: string; zeit: string; nachricht: WeltNachricht | null; frage: string | null }
export interface WeltTicket {
  id: string; titel: string; ziel: string; fertig: string; stand: string; adressaten: string[]; team: string | null;
  absender: string; bearbeiter: string | null; angelegt: string; geaendert: string; grenzen: Record<string, unknown>;
  abhaengig: string[]; wartet_auf: string[];
  ergebnis: { text: string; commit: string | null; von: string; zeit: string } | null;
  abnahme: { von: string; zeit: string; bemerkung: string | null } | null;
  verlauf: { zeit: string; ereignis: string; von: string; text: string }[];
  /** `limits.art` (z. B. `skill-vorschlag`), sonst leer. */
  art: string;
  skill_vorschlag: WeltSkillVorschlag | null;
}
export interface WeltFrage {
  id: string; text: string; optionen: string[]; empfehlung: string | null; ticket: string | null; stand: string;
  von: string; gestellt: string;
  antwort: { text: string; von: string; zeit: string } | null;
  ruecknahme: { grund: string | null; von: string; zeit: string } | null;
}
export interface WeltAgent {
  id: string; name: string; stufe: string; team: string | null; spezialgebiet: string;
  figur: { art: 'roboter' | 'tier' | 'kern' | 'linse'; rolle: string; farbe: string };
  modell: string; fallback: string; maschine: string; werkzeuge: string[]; skills: string[];
  bash: string[]; kontextgrenze: string; vorlage: string | null; angelegt_von: string | null;
  /** Der Skill-Reiter: aufgeloeste Skills, Verlauf, Messung (`skills` bleibt die Profilliste). */
  skill_ansicht: WeltSkills;
  stand: string; stand_grund: string | null; stand_seit: string; angelegt: string;
  zustand: AgentZustand; zustand_text: string; figur_zustand: string; ticket: string | null;
  postfach_offen: number; postfach_gesamt: number;
  denkstufe: string; fallback_denkstufe: string;
  gedaechtnis: { text: string; gekuerzt: boolean; geaendert: string | null; sha256: string };
  anweisungen: { text: string; gekuerzt: boolean };
  verlauf: unknown[];
  tickets: string[]; direktchats: string[]; einzelchat: ChatEintrag[];
  /** Auftrag agentaktiv: der Zug laut Traeger; null ohne Traeger oder wenn er nicht lesbar war. */
  zug: WeltZug | null;
  /** Das Lebenszeichen am Avatar; null ohne Traeger. */
  leben: WeltLeben | null;
  /** Der Stand unter der eigenen, noch unbeantworteten Nachricht im Einzelchat; null ohne Traeger oder ohne offene Nachricht. */
  antwort: WeltAntwortStand | null;
}
/** Je Agent aus `agents_traeger.py status --nur-zug` (shell/agents_traeger.py, `zug_stand`). */
export interface WeltZug {
  laeuft: boolean; seit: string | null; art: 'nachricht' | 'ticket' | 'frage' | 'recovery' | null;
  zustellung_offen: boolean; wartet_seit: string | null;
  /** Warum eine offene Zustellung keinen Zug hat: kontingent, anmeldung, recovery_limit, pausiert, gestoppt, ungeklaert, ein Urteil. */
  grund: string | null;
  naechster_wecker: string | null;
  letzter: { ende: string | null; ergebnis: string; art: string | null } | null;
}
export type LebenStand = 'arbeitet' | 'wartet' | 'schlaeft' | 'nicht_erreichbar';
export interface WeltLeben { stand: LebenStand; seit: string | null; grund: string | null; wecker: string | null }
/**
 * Unter der eigenen Nachricht: `zugestellt` (die Oberflaeche macht daraus nach 30 Sekunden „nicht gestartet"),
 * `arbeitet`, `beendet` (ein Zug endete ohne Antwort) oder `nicht_erreichbar`. `wecken`: was das Wecken nach dem
 * Senden aus diesem Kern ergab (`gestartet`, `laeuft`, `fehler`), leer, wenn der Kern es nicht weiss.
 */
export interface WeltAntwortStand {
  nachricht: string; zeit: string; stand: 'zugestellt' | 'arbeitet' | 'beendet' | 'nicht_erreichbar'; grund: string | null; wecken: string;
}
export interface WeltTeam { name: string; leiter: string | null; mitglieder: string[]; aktiv: number }
export interface WeltSkill {
  name: string; ebene: string; version: string; beschreibung: string; vorgeladen: boolean;
  verdeckt: { ebene: string; version: string; gleich: boolean }[]; skill_md: string; gekuerzt: boolean;
  befunde: { stufe: string; text: string }[]; dateien: string[]; veraltet: boolean;
}
export interface WeltSkillMessung { art: string; anzahl: number; mittel: number; mittel_letzte: number; letzte: number[]; veraenderung: number | null }
export interface WeltSkills {
  quelle: string | null; stand: string | null; liste: WeltSkill[]; fehlend: string[];
  ungueltig: { name: string; ebene: string; text: string }[];
  verlauf: { zeit: string; aktion: string; skill: string; ziel: string; ticket: string; text: string }[];
  messungen: WeltSkillMessung[]; fehler: string[];
}
export interface WeltSkillVorschlag {
  skill: string; agent: string; ziel: string; stand: string; version: string; basis_version: string | null;
  beschreibung: string; begruendung: string; pruefer: string; diff: string; diff_gekuerzt: boolean;
  entschieden_von: string | null; bemerkung: string | null; grund: string | null;
}
export interface WeltAntrag {
  id: string; von: string; an: string; agent: string; team: string | null; spezialgebiet: string; stand: string; zeit: string;
  entscheidung: string | null; bemerkung: string | null;
}
export interface WeltDirektchat { id: string; teilnehmer: string[]; nachrichten: WeltNachricht[]; gesamt: number }
export interface Welt {
  pfad: string; projekt: string | null; art: 'global' | 'projekt'; id: string; name: string;
  stand: string; stand_seit: string; stand_grund: string | null; konsistent: boolean; gelesen: string;
  fehler: string[];
  zaehler: { brauchen_dich: number; laufen: number; tickets_offen: number };
  hauptagent: string | null; teams: WeltTeam[]; ohne_team: string[]; liste: string[];
  agenten: WeltAgent[]; tickets: WeltTicket[]; kanal: WeltNachricht[]; kanal_gesamt: number;
  direktchats: WeltDirektchat[]; fragen: WeltFrage[]; antraege: WeltAntrag[];
  /** Die letzten Eintraege aus `skill-verlauf.jsonl`; `skills_fehler`, wenn die Skills nicht lesbar waren. */
  skill_verlauf: { zeit: string; ereignis: string; skill: string; ziel: string; agent: string; ticket: string }[];
  skills_fehler: string;
  /** Der Mensch der Welt: offene Zustellungen, markierte davon, sein Lesestand je Gespraech. */
  mensch: { postfach_offen: number; markiert_offen: { zustellung: string; von: string; markierung: string; zeit: string; text: string; ticket: string | null }[]; gelesen: Record<string, { zeit: string; id: string }> };
  /** Ungelesen je Gespraech (`kanal`, `einzel:<agent>`, `direkt:<chat>`) nach dem Lesestand der Welt. */
  ungelesen: Record<string, number>;
  /** Die Maschine der Ablage (`peer`) oder die eigene (`mac`). */
  maschine: string;
  /** Die Ablage liegt auf einer anderen Maschine; `pfad` heisst dann `<maschine>:<ablage>`. */
  fern: boolean;
  /** Der Pfad der Ablage auf ihrer Maschine. */
  ablage: string;
  /** Die Verbindung zur Maschine der Welt; lokal immer ok. `seit`: seit wann sie nicht erreichbar ist. */
  verbindung: { ok: boolean; seit: string | null; text: string };
  /** Zugaenge nach draussen, die der Mensch fuer die Welt eingerichtet hat (nur Anzeige). */
  zugaenge: { name: string; art: string }[];
  /**
   * `traeger.json` in der Ablage; `laeuft` null, wo es sich nicht feststellen laesst; `moeglich`: dort kann ein Traeger laufen;
   * `zug_fehler`: warum das Lebenszeichen nicht lesbar war (Auftrag agentaktiv), sonst leer.
   */
  traeger: { eingerichtet: boolean; laeuft: boolean | null; moeglich: boolean; zug_fehler: string };
  /**
   * Auftrag agentsform: die Modelle, die der Traeger dieser Welt fahren kann (`wb-welt ansicht`, Feld `modelle`);
   * null, solange die Ansicht das Feld nicht liefert -- dann gilt `modelle` der Nutzlast. Fable nie.
   */
  modelle: WeltModell[] | null;
  /** Die Maschine eines neuen Agenten (`maschine_vorgabe` der Ansicht); leer, solange die Ansicht sie nicht nennt. */
  maschine_vorgabe: string;
  /** Die Skills der Welt und der Bibliothek zur Auswahl beim Anlegen (`agents_skills_ansicht.py`, `katalog`). */
  skill_katalog: { welt: WeltSkillAuswahl[]; bibliothek: WeltSkillAuswahl[] };
  /** Ob die Welt einen Zugang der Art `web` hat: nur dann gibt es WebFetch und WebSearch fuer ihre Agenten. */
  web_zugang: boolean;
  /** Ob die Datenbibliothek auf der Maschine der Welt `agent rechte` kennt; sonst zeigt das Profil die Rechte nur an. */
  rechte_aenderbar: boolean;
}
/** Auftrag agentsform: ein Modell des Traegers einer Welt; `grund` sagt, warum es nicht verfuegbar ist. */
export interface WeltModell { id: string; harness: string; verfuegbar: boolean; grund: string }
export interface WeltSkillAuswahl { name: string; beschreibung: string }
/** Eine Maschine fuer Anlegen, Umzug und Fusszeile. */
export interface WeltMaschine {
  name: string; ssh: string; eigene: boolean; standard: boolean;
  /** Ob dort ein Traeger laufen kann: die eigene nur unter Linux, eine Fernmaschine ausser `mac`. */
  traeger: boolean;
  /** Stand der letzten Verbindung (nur Fernmaschinen; null = noch nie gefragt). */
  erreichbar: boolean | null; seit: string | null; text: string;
  welten: number; traeger_eingerichtet: number;
}
export interface WeltenNutzlast {
  geladen: boolean;
  fehler: { quelle: string; text: string }[];
  welten: Welt[];
  /** Die Datenbibliothek, gegen die gelesen wird -- leer, wenn keine gefunden wurde. */
  datenbibliothek: string;
  /** Vorlagen fuer das Anlege-Menue (`agents/bibliothek/`, `agent vorlagen`). */
  vorlagen: WeltVorlage[];
  /** Modelle fuer das Anlege-Menue aus `wb-state models table`, ohne Fable. */
  modelle: ModellZeile[];
  /** Modelle, die einen Vorschlag schreiben duerfen; das erste ist die Vorgabe. */
  entwurf_modelle: string[];
  /** Wo die globale Welt liegt oder angelegt wird (`AWB_WELTEN_GLOBAL`); leer, wenn keine eingestellt ist. */
  global_pfad: string;
  /** Die eigene Maschine zuerst, dann die Agent-Maschinen aus `agents.maschinen`. */
  maschinen: WeltMaschine[];
  /** Die Vorgabe beim Anlegen: die Standardmaschine (peer), sonst die eigene. */
  maschine_vorgabe: string;
  /** Auftrag agentsform: die gemerkten Projektordner (`welten-projekte.json`), zum Entfernen im Menue der Welten. */
  gemerkte_projekte: string[];
  /** Die Bash-Muster des Dienstwegs je Stufe, wie die Bibliothek sie jedem Entwurf gibt; nicht abwaehlbar. */
  bash_vorgabe: Record<string, string[]>;
}
export interface WeltVorlage { name: string; title: string; summary: string; draft: Record<string, unknown> }

export interface WeltenOptionen {
  python: string;
  /** Pfad zu `agents_data.py`; leer = nicht gefunden (steht dann in `fehler`). */
  daten: string;
  /** `agents_traeger.py` fuer das Lebenszeichen einer lokalen Welt mit `traeger.json` (AWB_AGENTS_TRAEGER, sonst neben `daten`). */
  traeger: string;
  wurzeln: string[];
  global: string;
  fristMs: number;
  findenMs: number;
  nachlesenMs: number;
  grenze: number;
  entwurf: EntwurfOptionen;
  /** Die Projektordner, in denen die Oberflaeche eine Welt angelegt hat (`welt:neu`); leer = nicht merken. */
  projekteDatei: string;
  /** Fernwelten: ssh, Laufzeit dort, Register, Fristen (fernwelten.ts). */
  fern: FernOptionen;
}

export interface WeltenHandlungsErgebnis {
  ok: boolean; handlung: string; id: string; meldung: string; rueckfrage?: string; warnungen?: string[];
  /** Vorschlag und Pruefung eines Agenten-Entwurfs (Nr. 3). */
  entwurf?: Record<string, unknown>; anweisungen?: string; pruefung?: string;
  aufruf?: VorschlagErgebnis['aufruf']; kosten?: number | null; dauer_ms?: number;
  /** `welt:gespraech`: Prosa des Modells, offene Fragen, ob der Entwurf aus seiner Sicht fertig ist, gesetzte Felder, ganzer Verlauf. */
  antwort?: string; fragen?: string[]; fertig?: boolean; felder?: string[]; verlauf?: GespraechZug[];
  /** `welt:neu`: die Ablage der angelegten (oder schon vorhandenen) Welt; `welt:umziehen`: die Kennung am neuen Ort. */
  pfad?: string;
  /** `welt:maschinen`: die Maschinen nach der Probe. */
  maschinen?: WeltMaschine[];
  /** `welt:umziehen`: der Plan (trocken) oder das Ergebnis von `wb-welt umziehen --json`. */
  umzug?: Record<string, unknown>;
}

/** Die Optionen aus der Umgebung. Die Bibliothek: AWB_AGENTS_DATA, sonst neben dem Kern im Repo, sonst ~/.local/bin. */
export function weltenOptionenAusUmgebung(env: NodeJS.ProcessEnv, home: string, kernOrdner: string, zustandOrdner?: string): WeltenOptionen {
  const zustand = zustandOrdner ?? env.AWB_STATE_DIR ?? join(home, '.config', 'agent-workbench');
  const kandidaten = [env.AWB_AGENTS_DATA ?? '', resolve(kernOrdner, '..', '..', '..', 'shell', 'agents_data.py'), join(home, '.local', 'bin', 'agents_data.py')];
  const daten = env.AWB_AGENTS_DATA !== undefined ? env.AWB_AGENTS_DATA : (kandidaten.slice(1).find((p) => existsSync(p)) ?? '');
  return {
    python: env.AWB_PYTHON ?? 'python3',
    daten,
    traeger: env.AWB_AGENTS_TRAEGER ?? (daten ? join(dirname(daten), 'agents_traeger.py') : ''),
    wurzeln: (env.AWB_WELTEN_WURZELN ?? join(home, 'AI')).split(':').filter(Boolean),
    global: env.AWB_WELTEN_GLOBAL ?? join(home, '.claude', 'workbench', 'agents'),
    fristMs: Number(env.AWB_WELTEN_FRIST_MS ?? 8000),
    findenMs: Number(env.AWB_WELTEN_FINDEN_MS ?? 30_000),
    nachlesenMs: Number(env.AWB_WELTEN_NACHLESEN_MS ?? 30_000),
    grenze: Number(env.AWB_WELTEN_GRENZE ?? 500),
    entwurf: entwurfOptionenAusUmgebung(env, home),
    projekteDatei: env.AWB_WELTEN_PROJEKTE ?? join(zustand, 'welten-projekte.json'),
    fern: fernOptionenAusUmgebung(env, zustand),
  };
}

// ---------------------------------------------------------------------------
// Reine Ableitungen -- exportiert, damit die Kern-Suite sie ohne Prozess prueft.
// ---------------------------------------------------------------------------

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const ENDSTAENDE = new Set(['abgenommen', 'verworfen']);

/** Die Figur eines Agenten: Art aus dem Profil (`--figur roboter|tier|linse` oder `{family}`), Kern fuer den Hauptagenten. */
export function figurAus(agent: RohAgent): WeltAgent['figur'] {
  const rolle = agent.stage === 'hauptagent' ? 'hauptagent' : agent.id;
  if (agent.stage === 'hauptagent') return { art: 'kern', rolle, farbe: '' };
  const f = agent.figure;
  const roh = typeof f === 'string' ? f : s((f as { family?: unknown } | null)?.family);
  const farbe = typeof f === 'object' && f ? s((f as { color?: unknown }).color) : '';
  const wort = roh.toLowerCase();
  if (wort === 'linse' || wort === 'reviewer') return { art: 'linse', rolle: 'reviewer', farbe };
  if (wort === 'tier' || wort === 'wesen' || wort === 'tierwesen') return { art: 'tier', rolle, farbe };
  return { art: 'roboter', rolle, farbe };
}

function nachricht(m: RohNachricht, agentIds: Set<string>, offen: Set<string> = new Set()): WeltNachricht {
  const agenten = m.recipients && m.recipients.length ? [...m.recipients] : [];
  const menschen = (m.humans ?? []).filter((h) => !agenten.includes(h));
  let an = [...agenten, ...menschen];
  if (!an.length && m.recipient) an = [m.recipient];
  const von = s(m.sender);
  return {
    id: m.id, art: s(m.kind) || 'kanal', von, an: m.recipient === 'alle' ? ['alle'] : an, text: s(m.text), zeit: s(m.time),
    ticket: m.ticket ?? null, betreff: s(m.subject), von_mensch: !!von && !agentIds.has(von),
    markierung: m.mark ?? null, offen_fuer_mensch: offen.has(m.id),
  };
}

/** Rang nach Handlungsbedarf (Plan Abschnitt 6, Liste): braucht dich, arbeitet, hat Ergebnis, schläft. */
export const BEDARF_RANG: Record<AgentZustand, number> = {
  braucht_dich: 0, arbeitet: 1, hat_ergebnis: 2, wartet: 3, schlaeft: 4, pausiert: 5, gestoppt: 6, archiviert: 7,
};

/** Das Wort des Figur-Vertrags (Agentenfigur.swift, `FigurZustand(vertrag:)`). */
export const FIGUR_ZUSTAND: Record<AgentZustand, string> = {
  braucht_dich: 'braucht_entscheidung', arbeitet: 'arbeitet', hat_ergebnis: 'ergebnis_ungelesen', wartet: 'fertig',
  schlaeft: 'fertig', pausiert: 'fertig', gestoppt: 'nicht_einsehbar', archiviert: 'nicht_einsehbar',
};

/**
 * Der Zustand eines Agenten aus den Weltdateien. Gestoppt und archiviert
 * zuerst; eine offene Frage des Hauptagenten schlaegt die Pause, denn sie
 * wartet auf den Menschen, nicht auf den Agenten.
 */
export function agentZustand(agent: RohAgent, weltStand: string, tickets: RohTicket[], fragen: RohFrage[],
  markiert: { markierung: string; ticket: string | null }[] = []): { zustand: AgentZustand; text: string; ticket: string | null } {
  const titel = (t: RohTicket) => `„${s(t.title) || t.id}“`;
  if (weltStand === 'gestoppt') return { zustand: 'gestoppt', text: 'gestoppt mit der Welt', ticket: null };
  if (agent.state === 'gestoppt') return { zustand: 'gestoppt', text: agent.runtime?.reason ? `gestoppt: ${agent.runtime.reason}` : 'gestoppt', ticket: null };
  if (agent.state === 'archiviert') return { zustand: 'archiviert', text: 'archiviert', ticket: null };
  const offeneFragen = agent.stage === 'hauptagent' ? fragen.filter((f) => f.state === 'offen' && (!f.sender || f.sender === agent.id)) : [];
  const brauchtDich = tickets.find((t) => t.state === 'braucht dich' && (t.assignee === agent.id || (t.recipients ?? []).includes(agent.id)));
  if (offeneFragen.length) {
    return { zustand: 'braucht_dich', text: offeneFragen.length === 1 ? 'braucht dich: eine Frage' : `braucht dich: ${offeneFragen.length} Fragen`, ticket: offeneFragen[0].ticket ?? null };
  }
  if (brauchtDich) return { zustand: 'braucht_dich', text: `braucht dich bei ${titel(brauchtDich)}`, ticket: brauchtDich.id };
  if (markiert.length) {
    const fragen = markiert.filter((x) => x.markierung === 'frage').length;
    const text = markiert.length === 1
      ? (fragen ? 'braucht dich: eine Frage im Chat' : 'braucht dich: ein Ergebnis im Chat')
      : `braucht dich: ${markiert.length} markierte Nachrichten`;
    return { zustand: 'braucht_dich', text, ticket: markiert[0].ticket };
  }
  if (weltStand === 'pausiert') return { zustand: 'pausiert', text: 'pausiert mit der Welt', ticket: null };
  if (agent.state === 'pausiert') return { zustand: 'pausiert', text: agent.runtime?.reason ? `pausiert: ${agent.runtime.reason}` : 'pausiert', ticket: null };
  const laeuft = tickets.find((t) => t.state === 'läuft' && t.assignee === agent.id);
  if (laeuft) return { zustand: 'arbeitet', text: `arbeitet an ${titel(laeuft)}`, ticket: laeuft.id };
  const ergebnis = tickets.find((t) => t.state === 'zur Abnahme' && t.assignee === agent.id);
  if (ergebnis) return { zustand: 'hat_ergebnis', text: `Ergebnis zu ${titel(ergebnis)} wartet auf Abnahme`, ticket: ergebnis.id };
  const wartet = tickets.find((t) => t.state === 'wartet' && t.assignee === agent.id);
  if (wartet) return { zustand: 'wartet', text: `wartet bei ${titel(wartet)}`, ticket: wartet.id };
  const zurueck = tickets.find((t) => t.state === 'zurückgegeben' && t.assignee === agent.id);
  if (zurueck) return { zustand: 'schlaeft', text: `schläft, ${titel(zurueck)} zurückgegeben`, ticket: zurueck.id };
  const offen = tickets.filter((t) => t.state === 'offen' && (t.recipients ?? []).includes(agent.id));
  if (offen.length) return { zustand: 'schlaeft', text: offen.length === 1 ? `schläft, ${titel(offen[0])} offen` : `schläft, ${offen.length} Tickets offen`, ticket: offen[0].id };
  return { zustand: 'schlaeft', text: 'schläft', ticket: null };
}

/** Ein Ticket als Zeile der Ansicht; `wartet_auf` nennt Abhaengigkeiten, die noch nicht abgenommen sind. */
export function ticketAus(t: RohTicket, alle: RohTicket[]): WeltTicket {
  const stand = new Map(alle.map((x) => [x.id, s(x.state)]));
  const deps = t.dependencies ?? [];
  return {
    id: t.id, titel: s(t.title) || t.id, ziel: s(t.goal), fertig: s(t.done_criterion), stand: s(t.state),
    adressaten: [...(t.recipients ?? [])], team: t.team ?? null, absender: s(t.sender), bearbeiter: t.assignee ?? null,
    angelegt: s(t.created_at), geaendert: s(t.updated_at), grenzen: t.limits ?? {}, abhaengig: [...deps],
    wartet_auf: deps.filter((d) => stand.get(d) !== 'abgenommen'),
    ergebnis: t.result ? { text: s(t.result.text), commit: t.result.commit ?? null, von: s(t.result.agent), zeit: s(t.result.written_at) } : null,
    abnahme: t.approval ? { von: s(t.approval.agent), zeit: s(t.approval.time), bemerkung: t.approval.note ?? null } : null,
    verlauf: (t.history?.events ?? []).map((e) => ({
      zeit: s(e.time), ereignis: s(e.event), von: s(e.actor?.id),
      text: s(e.note) || s(e.reason) || (e.assignee ? `an ${e.assignee}` : '') || (e.commit ? `Commit ${e.commit}` : ''),
    })),
    art: s((t.limits ?? {}).art),
    skill_vorschlag: null,
  };
}

// --- Skills (agents_skills_ansicht.py) ------------------------------------------

type RohObjekt = Record<string, unknown>;
export interface RohSkillAnsicht {
  agenten?: Record<string, RohObjekt>; vorschlaege?: Record<string, RohObjekt>; verlauf?: RohObjekt[];
  /** Auftrag agentsform: die gueltigen Skills der Welt und der Bibliothek. */
  katalog?: { welt?: RohObjekt[]; bibliothek?: RohObjekt[] };
}
const zahlVon = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const liste = (v: unknown): RohObjekt[] => (Array.isArray(v) ? v.filter((x): x is RohObjekt => !!x && typeof x === 'object') : []);

export function leereSkills(fehler: string[] = []): WeltSkills {
  return { quelle: null, stand: null, liste: [], fehlend: [], ungueltig: [], verlauf: [], messungen: [], fehler };
}

/** Die Skills eines Agenten aus der Rohform von `agents_skills_ansicht.py`. */
export function skillsAus(roh: RohObjekt | undefined): WeltSkills {
  if (!roh) return leereSkills();
  const arten = (roh.messung as RohObjekt | undefined)?.arten as Record<string, RohObjekt> | undefined;
  return {
    quelle: typeof roh.quelle === 'string' ? roh.quelle : null,
    stand: typeof roh.stand === 'string' ? roh.stand : null,
    liste: liste(roh.skills).map((x) => ({
      name: s(x.name), ebene: s(x.ebene), version: s(x.version), beschreibung: s(x.description), vorgeladen: x.vorgeladen === true,
      verdeckt: liste(x.verdeckt).map((v) => ({ ebene: s(v.ebene), version: s(v.version), gleich: v.gleich === true })),
      skill_md: s(x.skill_md), gekuerzt: x.gekuerzt === true,
      befunde: liste(x.befunde).map((b) => ({ stufe: s(b.stufe), text: s(b.text) })),
      dateien: Array.isArray(x.dateien) ? x.dateien.map(String) : [], veraltet: x.veraltet === true,
    })),
    fehlend: Array.isArray(roh.fehlend) ? roh.fehlend.map(String) : [],
    ungueltig: liste(roh.ungueltig).map((x) => ({ name: s(x.name), ebene: s(x.ebene), text: liste(x.befunde).map((b) => s(b.text)).join('; ') })),
    verlauf: liste(roh.verlauf).map((e) => ({
      zeit: s(e.time), aktion: e.event === 'lernschritt' ? `lernschritt ${s(e.status)}`.trim() : s(e.aktion),
      skill: s(e.skill), ziel: s(e.ziel), ticket: s(e.ticket), text: s(e.grund) || s(e.bemerkung) || s(e.note),
    })),
    messungen: Object.entries(arten ?? {}).map(([art, m]) => ({
      art, anzahl: zahlVon(m.anzahl), mittel: zahlVon((m.mittel as RohObjekt | undefined)?.gesamt),
      mittel_letzte: zahlVon((m.mittel_letzte as RohObjekt | undefined)?.gesamt),
      letzte: liste(m.letzte).map((l) => zahlVon((l.tokens as RohObjekt | undefined)?.gesamt)),
      veraenderung: typeof m.veraenderung === 'number' ? m.veraenderung : null,
    })),
    fehler: Array.isArray(roh.fehler) ? roh.fehler.map(String) : [],
  };
}

/** Skills, Vorschlaege und Skill-Verlauf in eine gelesene Welt einsetzen. */
export function skillsEinsetzen(welt: Welt, roh: RohSkillAnsicht | null, fehler: string): Welt {
  if (!roh) {
    return { ...welt, skills_fehler: fehler, agenten: welt.agenten.map((a) => ({ ...a, skill_ansicht: leereSkills(fehler ? [fehler] : []) })) };
  }
  const vorschlaege = roh.vorschlaege ?? {};
  return {
    ...welt,
    skills_fehler: '',
    agenten: welt.agenten.map((a) => ({ ...a, skill_ansicht: skillsAus(roh.agenten?.[a.id]) })),
    tickets: welt.tickets.map((t) => {
      const v = vorschlaege[t.id];
      if (!v || typeof v.skill !== 'string') return t;
      return {
        ...t,
        skill_vorschlag: {
          skill: s(v.skill), agent: s(v.agent), ziel: s(v.ziel), stand: s(v.stand), version: s(v.version),
          basis_version: typeof v.basis_version === 'string' ? v.basis_version : null, beschreibung: s(v.beschreibung),
          begruendung: s(v.begruendung), pruefer: s(v.pruefer), diff: s(v.diff), diff_gekuerzt: v.diff_gekuerzt === true,
          entschieden_von: typeof v.entschieden_von === 'string' ? v.entschieden_von : null,
          bemerkung: typeof v.bemerkung === 'string' ? v.bemerkung : null, grund: typeof v.grund === 'string' ? v.grund : null,
        },
      };
    }),
    skill_verlauf: liste(roh.verlauf).map((e) => ({
      zeit: s(e.time), ereignis: s(e.event), skill: s(e.skill), ziel: s(e.ziel), agent: s(e.agent), ticket: s(e.ticket),
    })),
    skill_katalog: skillKatalogAus(roh.katalog),
  };
}

/** Auftrag agentsform: der Skillkatalog der Welt und der Bibliothek; ohne Angabe leer. */
export function skillKatalogAus(roh: RohSkillAnsicht['katalog']): Welt['skill_katalog'] {
  const ebene = (x: unknown): WeltSkillAuswahl[] => liste(x).filter((e) => s(e.name)).map((e) => ({ name: s(e.name), beschreibung: s(e.beschreibung) }));
  return { welt: ebene(roh?.welt), bibliothek: ebene(roh?.bibliothek) };
}

/** Auftrag agentsform: die Modelle einer Welt aus `wb-welt ansicht`; null, wenn das Feld fehlt. Fable nie. */
export function modelleAus(roh: unknown): WeltModell[] | null {
  if (!Array.isArray(roh)) return null;
  return roh.filter((m): m is RohObjekt => !!m && typeof m === 'object')
    .map((m) => ({ id: s(m.id), harness: s(m.harness), verfuegbar: m.verfuegbar === true, grund: s(m.grund) }))
    .filter((m) => m.id && !/fable/i.test(m.id));
}

export function frageAus(f: RohFrage): WeltFrage {
  return {
    id: f.id, text: s(f.text), optionen: [...(f.options ?? [])], empfehlung: f.recommendation ?? null, ticket: f.ticket ?? null,
    stand: s(f.state), von: s(f.sender), gestellt: s(f.created_at),
    antwort: f.answer ? { text: s(f.answer.text), von: s(f.answer.sender), zeit: s(f.answer.answered_at) } : null,
    ruecknahme: f.withdrawal ? { grund: f.withdrawal.reason ?? null, von: s(f.withdrawal.sender), zeit: s(f.withdrawal.withdrawn_at) } : null,
  };
}

const nachZeit = (a: { zeit: string; id: string }, b: { zeit: string; id: string }) => (a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0);

/**
 * DER EINZELCHAT eines Agenten (Plan Abschnitt 4): das Gespraech mit dem
 * Menschen, ohne Kanal-Interna. Darin stehen die Direktchats, in denen ausser
 * ihm nur Menschen sprechen, seine Kanalnachrichten an einen Menschen (heute
 * die Ergebnisse von Tickets, die ein Mensch angelegt hat) und -- beim
 * Hauptagenten -- seine Fragen, jede an ihrer Stelle in der Zeit.
 */
export function einzelchat(agentId: string, agentIds: Set<string>, kanal: WeltNachricht[], chats: WeltDirektchat[], fragen: WeltFrage[]): ChatEintrag[] {
  const raus: ChatEintrag[] = [];
  for (const c of chats) {
    const andere = c.teilnehmer.filter((t) => t !== agentId);
    if (!c.teilnehmer.includes(agentId) || !andere.length || andere.some((t) => agentIds.has(t))) continue;
    for (const n of c.nachrichten) raus.push({ art: 'nachricht', id: n.id, zeit: n.zeit, nachricht: n, frage: null });
  }
  for (const n of kanal) {
    if (n.von === agentId && n.an.some((a) => a !== 'alle' && !agentIds.has(a))) {
      raus.push({ art: 'nachricht', id: n.id, zeit: n.zeit, nachricht: n, frage: null });
    }
  }
  for (const f of fragen) if (f.von === agentId) raus.push({ art: 'frage', id: f.id, zeit: f.gestellt, nachricht: null, frage: f.id });
  // Stabil sortiert: gleiche Sekunde behaelt die Reihenfolge der Quelle.
  return raus.map((e, i) => ({ e, i })).sort((a, b) => nachZeit(a.e, b.e) || a.i - b.i).map((x) => x.e);
}

/** Ungelesen: Nachrichten, die nicht von einem Menschen kommen und nach der Marke (Zeit, dann Kennung) liegen. */
export function ungelesenZaehlen(nachrichten: WeltNachricht[], marke?: { zeit: string; id: string }): number {
  return nachrichten.filter((n) => !n.von_mensch && (!marke || n.zeit > marke.zeit || (n.zeit === marke.zeit && n.id > marke.id))).length;
}

/** Ein Schluessel des Lesestands, wie `wb-welt gelesen` ihn annimmt. */
export function gespraechGueltig(schluessel: string): boolean {
  return /^(kanal|einzel:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|direkt:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(schluessel);
}

/** Hauptagent zuerst, dann nach Handlungsbedarf, dann nach Name (Plan Abschnitt 6, „Liste"). */
export function listeOrdnen(agenten: WeltAgent[]): string[] {
  return [...agenten].sort((a, b) =>
    Number(b.stufe === 'hauptagent') - Number(a.stufe === 'hauptagent')
    || BEDARF_RANG[a.zustand] - BEDARF_RANG[b.zustand] || a.name.localeCompare(b.name, 'de')).map((a) => a.id);
}

/** Teams nach Name; Leiter ist der erste Teamleiter, `aktiv` zaehlt Mitglieder, die arbeiten oder ein Ergebnis haben. */
export function teamsBilden(agenten: WeltAgent[]): { teams: WeltTeam[]; ohneTeam: string[] } {
  const namen = [...new Set(agenten.filter((a) => a.stufe !== 'hauptagent' && a.team).map((a) => a.team as string))].sort((a, b) => a.localeCompare(b, 'de'));
  const nachName = (a: WeltAgent, b: WeltAgent) => a.name.localeCompare(b.name, 'de');
  const teams = namen.map((name) => {
    const im = agenten.filter((a) => a.team === name && a.stufe !== 'hauptagent');
    const leiter = im.filter((a) => a.stufe === 'teamleiter').sort(nachName)[0] ?? null;
    const mitglieder = im.filter((a) => a !== leiter).sort(nachName);
    return { name, leiter: leiter?.id ?? null, mitglieder: mitglieder.map((a) => a.id), aktiv: mitglieder.filter((a) => a.zustand === 'arbeitet' || a.zustand === 'hat_ergebnis').length };
  });
  const ohneTeam = agenten.filter((a) => a.stufe !== 'hauptagent' && !a.team).sort(nachName).map((a) => a.id);
  return { teams, ohneTeam };
}

/** Eine ganze Welt aus ihrer Ansicht. */
export function weltAus(roh: RohAnsicht, fund: RohFund, grenze = 500): Welt {
  const w = roh.world ?? {};
  const rohAgenten = roh.agents ?? [];
  const agentIds = new Set(rohAgenten.map((a) => a.id));
  const rohTickets = roh.tickets ?? [];
  const alleFragen = roh.questions ?? [];
  const rohFragen = alleFragen.filter((f) => f.kind !== 'agent-antrag');
  const antraege: WeltAntrag[] = alleFragen.filter((f) => f.kind === 'agent-antrag').map((f) => ({
    id: f.id, von: s(f.sender), an: s(f.to), agent: s(f.draft?.id), team: f.draft?.team ?? null, spezialgebiet: s(f.draft?.specialty),
    stand: s(f.state) || 'offen', zeit: s(f.created_at), entscheidung: f.answer?.text ?? null, bemerkung: f.answer?.note ?? null,
  })).sort((a, b) => (a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0));
  const stand = s(w.state) || 'läuft';
  const rohMensch = roh.humans?.[WELT_MENSCH] ?? {};
  const zustellungen = rohMensch.postbox?.deliveries ?? [];
  const offen = new Set(zustellungen.filter((z) => !z.acknowledged).map((z) => s(z.delivery_id) || z.id));
  const markiertOffen = zustellungen.filter((z) => !z.acknowledged && (z.mark === 'frage' || z.mark === 'ergebnis')).map((z) => ({
    zustellung: s(z.delivery_id) || z.id, von: s(z.sender), markierung: s(z.mark), zeit: s(z.time), text: s(z.text), ticket: z.ticket ?? null,
  }));
  const kanal = (roh.channel ?? []).map((m) => nachricht(m, agentIds, offen));
  const direktchats: WeltDirektchat[] = (roh.direct_chats ?? []).map((c) => ({
    id: c.id, teilnehmer: [...(c.participants ?? [])], nachrichten: (c.messages ?? []).map((m) => nachricht(m, agentIds, offen)), gesamt: c.total ?? 0,
  }));
  const fragen = rohFragen.map(frageAus).sort((a, b) => nachZeit({ zeit: a.gestellt, id: a.id }, { zeit: b.gestellt, id: b.id }));
  const agenten: WeltAgent[] = rohAgenten.map((a) => {
    const z = agentZustand(a, stand, rohTickets, rohFragen, markiertOffen.filter((x) => x.von === a.id));
    const mp = a.model_profile ?? {};
    const verlauf = a.history?.entries ?? [];
    return {
      id: a.id, name: s(a.name) || a.id, stufe: s(a.stage) || 'mitglied', team: a.team ?? null, spezialgebiet: s(a.specialty),
      figur: figurAus(a), modell: s(mp.model), fallback: s(mp.fallback_model), maschine: s(a.machine),
      denkstufe: s(mp.effort), fallback_denkstufe: s(mp.fallback_effort),
      werkzeuge: [...(a.tools ?? [])], skills: [...(a.skills ?? [])],
      bash: [...(a.bash ?? [])], kontextgrenze: s(a.context_limit), vorlage: a.template ?? null, angelegt_von: a.created_by?.id ?? null,
      skill_ansicht: leereSkills(),
      stand: s(a.state) || 'aktiv', stand_grund: a.runtime?.reason ?? null, stand_seit: s(a.runtime?.updated_at) || s(a.updated_at),
      angelegt: s(a.created_at),
      zustand: z.zustand, zustand_text: z.text, figur_zustand: FIGUR_ZUSTAND[z.zustand], ticket: z.ticket,
      postfach_offen: a.postbox?.open ?? 0, postfach_gesamt: a.postbox?.total ?? 0,
      gedaechtnis: { text: s(a.memory?.text), gekuerzt: a.memory?.truncated === true, geaendert: a.memory?.modified_at ?? null, sha256: s(a.memory?.sha256) },
      anweisungen: { text: s(a.instructions?.text), gekuerzt: a.instructions?.truncated === true },
      verlauf: verlauf.slice(-grenze),
      tickets: rohTickets.filter((t) => t.assignee === a.id || (t.recipients ?? []).includes(a.id) || (!!t.team && t.team === a.team && !t.assignee)).map((t) => t.id),
      direktchats: direktchats.filter((c) => c.teilnehmer.includes(a.id) && c.teilnehmer.some((t) => t !== a.id && agentIds.has(t))).map((c) => c.id),
      einzelchat: [],
      zug: null, leben: null, antwort: null,
    };
  });
  for (const a of agenten) a.einzelchat = einzelchat(a.id, agentIds, kanal, direktchats, fragen).slice(-grenze);
  const { teams, ohneTeam } = teamsBilden(agenten);
  const tickets = rohTickets.map((t) => ticketAus(t, rohTickets));
  const stop = stand === 'gestoppt' ? w.stop : stand === 'pausiert' ? w.pause : null;
  const gelesen: Record<string, { zeit: string; id: string }> = {};
  for (const [k, v] of Object.entries(rohMensch.read_state ?? {})) gelesen[k] = { zeit: s(v?.time), id: s(v?.id) };
  const ungelesen: Record<string, number> = { kanal: ungelesenZaehlen(kanal, gelesen.kanal) };
  for (const a of agenten) {
    ungelesen[`einzel:${a.id}`] = ungelesenZaehlen(a.einzelchat.map((e) => e.nachricht).filter((n): n is WeltNachricht => !!n), gelesen[`einzel:${a.id}`]);
  }
  for (const c of direktchats) ungelesen[`direkt:${c.id}`] = ungelesenZaehlen(c.nachrichten, gelesen[`direkt:${c.id}`]);
  return {
    pfad: roh.path || fund.path, projekt: fund.project, art: fund.kind === 'global' ? 'global' : 'projekt',
    id: s(w.id) || fund.id || fund.path, name: s(w.name) || fund.name || basename(fund.project ?? fund.path),
    stand, stand_seit: s(stop?.changed_at) || s(w.updated_at), stand_grund: stop?.reason ?? null,
    konsistent: roh.consistent !== false, gelesen: s(roh.read_at),
    fehler: (roh.errors ?? []).map((e) => `${s(e.section)}: ${s(e.text)}`),
    zaehler: {
      brauchen_dich: fragen.filter((f) => f.stand === 'offen').length + rohTickets.filter((t) => t.state === 'braucht dich').length + markiertOffen.length,
      laufen: agenten.filter((a) => a.zustand === 'arbeitet').length,
      tickets_offen: rohTickets.filter((t) => !ENDSTAENDE.has(s(t.state))).length,
    },
    hauptagent: agenten.find((a) => a.stufe === 'hauptagent')?.id ?? null,
    teams, ohne_team: ohneTeam, liste: listeOrdnen(agenten),
    agenten, tickets, kanal, kanal_gesamt: roh.channel_total ?? kanal.length, direktchats, fragen, antraege,
    skill_verlauf: [], skills_fehler: '',
    zugaenge: (roh.zugaenge ?? []).filter((x) => s(x.name)).map((x) => ({ name: s(x.name), art: s(x.art) || 'ssh' })),
    mensch: { postfach_offen: rohMensch.postbox?.open ?? offen.size, markiert_offen: markiertOffen, gelesen },
    ungelesen,
    ...ORT_LOKAL(roh.path || fund.path),
    modelle: modelleAus(roh.modelle), maschine_vorgabe: s(roh.maschine_vorgabe),
    skill_katalog: { welt: [], bibliothek: [] },
    web_zugang: (roh.zugaenge ?? []).some((x) => s(x.name) && x.art === 'web'),
    rechte_aenderbar: false,
  };
}

/** Eine Welt, die sich nicht lesen liess: sie steht mit ihrem Fehler da, statt zu verschwinden. */
export function weltMitFehler(fund: RohFund, text: string): Welt {
  return {
    pfad: fund.path, projekt: fund.project, art: fund.kind === 'global' ? 'global' : 'projekt',
    id: fund.id ?? fund.path, name: fund.name ?? basename(fund.project ?? fund.path), stand: fund.state ?? '', stand_seit: '', stand_grund: null,
    konsistent: false, gelesen: '', fehler: [text], zaehler: { brauchen_dich: 0, laufen: 0, tickets_offen: 0 },
    hauptagent: null, teams: [], ohne_team: [], liste: [], agenten: [], tickets: [], kanal: [], kanal_gesamt: 0, direktchats: [], fragen: [], antraege: [], skill_verlauf: [], skills_fehler: '',
    zugaenge: [],
    mensch: { postfach_offen: 0, markiert_offen: [], gelesen: {} }, ungelesen: {},
    ...ORT_LOKAL(fund.path),
    modelle: null, maschine_vorgabe: '', skill_katalog: { welt: [], bibliothek: [] }, web_zugang: false, rechte_aenderbar: false,
  };
}

/** Der Ort einer Welt, bis `lesen` ihn kennt: lokal, ohne Traeger. */
function ORT_LOKAL(ablage: string): Pick<Welt, 'maschine' | 'fern' | 'ablage' | 'verbindung' | 'traeger'> {
  return { maschine: '', fern: false, ablage, verbindung: { ok: true, seit: null, text: '' }, traeger: { eingerichtet: false, laeuft: null, moeglich: false, zug_fehler: '' } };
}

// ---------------------------------------------------------------------------
// Das Lebenszeichen (Auftrag agentaktiv) -- reine Ableitungen, die Kern-Suite prueft sie ohne Prozess.
// ---------------------------------------------------------------------------

const ZUG_ARTEN = new Set(['nachricht', 'ticket', 'frage', 'recovery']);
const optIso = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Ein Eintrag aus `agenten` von `status --nur-zug`; alles andere heisst: kein Zug lesbar. */
export function zugAus(roh: unknown): WeltZug | null {
  if (!roh || typeof roh !== 'object' || typeof (roh as { laeuft?: unknown }).laeuft !== 'boolean') return null;
  const r = roh as Record<string, unknown>;
  const l = r.letzter && typeof r.letzter === 'object' ? r.letzter as Record<string, unknown> : null;
  return {
    laeuft: r.laeuft === true, seit: optIso(r.seit), art: ZUG_ARTEN.has(s(r.art)) ? s(r.art) as WeltZug['art'] : null,
    zustellung_offen: r.zustellung_offen === true, wartet_seit: optIso(r.wartet_seit), grund: optIso(r.grund),
    naechster_wecker: optIso(r.naechster_wecker),
    letzter: l && typeof l.ergebnis === 'string' ? { ende: optIso(l.ende), ergebnis: l.ergebnis, art: optIso(l.art) } : null,
  };
}

/** Das Lebenszeichen am Avatar: arbeitet (ein Zug laeuft), wartet (Zustellung ohne Zug), schlaeft, nicht erreichbar. */
export function lebenAus(zug: WeltZug | null, erreichbar: boolean): WeltLeben {
  if (!erreichbar || !zug) return { stand: 'nicht_erreichbar', seit: null, grund: null, wecker: null };
  if (zug.laeuft) return { stand: 'arbeitet', seit: zug.seit, grund: null, wecker: null };
  if (zug.zustellung_offen) return { stand: 'wartet', seit: zug.wartet_seit, grund: zug.grund, wecker: zug.naechster_wecker };
  return { stand: 'schlaeft', seit: null, grund: null, wecker: zug.naechster_wecker };
}

const zeitWert = (iso: string | null): number => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Der Stand unter der eigenen Nachricht: die juengste Nachricht eines Menschen im Einzelchat, nach der der
 * Agent weder geschrieben noch gefragt hat. Ohne Traeger oder ohne solche Nachricht null.
 */
export function antwortStand(a: WeltAgent, leben: WeltLeben | null, traegerLaeuft: boolean | null, wecken = ''): WeltAntwortStand | null {
  if (!leben) return null;
  let i = a.einzelchat.length - 1;
  while (i >= 0 && !a.einzelchat[i].nachricht?.von_mensch) {
    const e = a.einzelchat[i];
    if (e.art === 'frage' || (e.nachricht && e.nachricht.von === a.id)) return null;
    i--;
  }
  const m = i >= 0 ? a.einzelchat[i].nachricht : null;
  if (!m) return null;
  const zug = a.zug;
  let stand: WeltAntwortStand['stand'] = 'zugestellt';
  let grund: string | null = null;
  if (leben.stand === 'nicht_erreichbar') stand = 'nicht_erreichbar';
  else if (zug?.laeuft) stand = 'arbeitet';
  else if (zug && !zug.zustellung_offen && zug.letzter && zeitWert(zug.letzter.ende) >= zeitWert(m.zeit)) {
    stand = 'beendet';
    grund = zug.letzter.ergebnis;
  } else {
    grund = zug?.grund ?? (traegerLaeuft === false ? 'traeger_aus' : null);
  }
  return { nachricht: m.id, zeit: m.zeit, stand, grund, wecken };
}

/**
 * Das Lebenszeichen in eine gelesene Welt einsetzen. Mit Traeger heisst „arbeitet" dann: ein Zug laeuft --
 * ein Ticket auf „läuft" ohne Zug schlaeft, ein Zug ohne laufendes Ticket arbeitet (eine Nachricht); braucht
 * dich, Pause und Stopp bleiben. Zaehler, Liste und Teams folgen dem neuen Zustand.
 */
export function zugEinsetzen(w: Welt, roh: Record<string, unknown> | null | undefined, geweckt: Record<string, string> = {}): Welt {
  if (!w.traeger.eingerichtet) return w;
  const erreichbar = w.verbindung.ok && !!roh;
  const titel = (id: string | null): string => `„${w.tickets.find((t) => t.id === id)?.titel ?? id}“`;
  const agenten = w.agenten.map((a): WeltAgent => {
    const zug = roh ? zugAus(roh[a.id]) : null;
    // Ein Agent, den der Status (noch) nicht nennt -- eben angelegt --, hat kein Lebenszeichen; nicht erreichbar
    // heisst nur: der Status selbst fehlt oder die Maschine antwortet nicht.
    const leben = erreichbar && !zug ? null : lebenAus(zug, erreichbar);
    let { zustand, zustand_text: text, ticket } = a;
    if (zug?.laeuft && !['braucht_dich', 'pausiert', 'gestoppt', 'archiviert'].includes(zustand)) {
      const laufend = w.tickets.find((t) => t.stand === 'läuft' && t.bearbeiter === a.id);
      zustand = 'arbeitet';
      text = zug.art === 'ticket' && laufend ? `arbeitet an ${titel(laufend.id)}` : 'arbeitet';
      if (laufend) ticket = laufend.id;
    } else if (zug && !zug.laeuft && zustand === 'arbeitet') {
      zustand = 'schlaeft';
      text = `schläft, ${titel(a.ticket)} läuft`;
    }
    const neu: WeltAgent = { ...a, zug, leben, zustand, zustand_text: text, figur_zustand: FIGUR_ZUSTAND[zustand], ticket, antwort: null };
    neu.antwort = antwortStand(neu, leben, w.traeger.laeuft, geweckt[a.id] ?? '');
    return neu;
  });
  const { teams, ohneTeam } = teamsBilden(agenten);
  return {
    ...w, agenten, teams, ohne_team: ohneTeam, liste: listeOrdnen(agenten),
    zaehler: { ...w.zaehler, laufen: agenten.filter((a) => a.zustand === 'arbeitet').length },
  };
}

/** Die Kennung einer Welt in Nutzlast und Handlungen: der Pfad, bei einer Fernwelt `<maschine>:<pfad>`. */
export function fundSchluessel(f: RohFund): string {
  return f.maschine ? fernSchluessel(f.maschine, f.path) : f.path;
}

/** Nach welchen Handlungen der Traeger geweckt wird: sie legen eine Zustellung an oder geben wartende frei. */
export const WECKEN: ReadonlySet<string> = new Set(['senden', 'antworten', 'ticket', 'zurueckgeben', 'fortsetzen']);

/** Die Antwort von `agents_weltauftrag.py wecken` als Satz fuer die Meldung; ohne Traeger nichts. */
export function weckSatz(r: { wecken?: unknown; wecken_fehler?: unknown }): string {
  if (typeof r.wecken_fehler === 'string' && r.wecken_fehler) return ` Träger nicht geweckt: ${r.wecken_fehler}`;
  if (r.wecken === 'gestartet') return ' Träger geweckt.';
  if (r.wecken === 'laeuft') return ' Träger läuft schon.';
  return '';
}

/** Dieselbe Antwort als Wort fuer den Stand unter der Nachricht: `gestartet`, `laeuft`, `fehler` oder leer. */
export function weckWort(r: { wecken?: unknown; wecken_fehler?: unknown }): string {
  if (typeof r.wecken_fehler === 'string' && r.wecken_fehler) return 'fehler';
  return r.wecken === 'gestartet' || r.wecken === 'laeuft' ? r.wecken : '';
}

/** Adressen der Eingabe in Kennungen: `alle`, `team:<name>` (Leiter und Mitglieder) oder ein Agent. */
export function adressenAufloesen(welt: Welt, an: string[]): { ids: string[]; fehler: string } {
  const ids: string[] = [];
  for (const roh of an) {
    const a = roh.trim().replace(/^@/, '');
    if (!a) continue;
    if (a === 'alle') {
      if (an.length !== 1) return { ids: [], fehler: '„alle“ lässt sich nicht mit anderen Adressen mischen.' };
      return { ids: ['alle'], fehler: '' };
    }
    if (a.startsWith('team:')) {
      const team = welt.teams.find((t) => t.name === a.slice(5));
      if (!team) return { ids: [], fehler: `Kein Team „${a.slice(5)}“ in ${welt.name}.` };
      for (const id of [team.leiter, ...team.mitglieder]) if (id && !ids.includes(id)) ids.push(id);
      continue;
    }
    if (!welt.agenten.some((x) => x.id === a)) return { ids: [], fehler: `Kein Agent „${a}“ in ${welt.name}.` };
    if (!ids.includes(a)) ids.push(a);
  }
  if (!ids.length) return { ids: [], fehler: 'Die Nachricht braucht einen Adressaten.' };
  return { ids, fehler: '' };
}

/** Wer schreibt: ein echter Klick in der Oberflaeche als `mensch`, alles andere als `cli-operator`. Nie ein Beleg. */
export function absenderFuer(herkunft: 'oberflaeche' | 'steuerkanal', echt: boolean): 'mensch' | 'cli-operator' {
  return herkunft === 'oberflaeche' && echt ? 'mensch' : 'cli-operator';
}

/**
 * Auftrag agentsform: wie `agent rechte` seine Listen nimmt, gelesen aus der Hilfe des Unterbefehls, je Schalter --
 * `nargs` (`--bash A B`), `mehrfach` (`--bash=A --bash=B`, „wiederholbar") oder `komma` (`--werkzeuge=Read,Write`).
 * `ohneBash`: es gibt `--ohne-bash` fuer „keine eigenen Muster"; `welt`: die Welt geht als erstes Argument oder
 * als `--welt=`. null: die Bibliothek kennt den Unterbefehl nicht (noch nicht ausgerollt). Gemessen am Zweig
 * wb/agentrechte (643d4b3): `--werkzeuge` und `--skills` mit Komma, `--bash` wiederholbar, `--ohne-bash`.
 */
export type Listenform = 'nargs' | 'mehrfach' | 'komma';
export interface RechteForm { werkzeuge: Listenform; bash: Listenform; skills: Listenform; ohneBash: boolean; welt: 'argument' | 'schalter' }

/** Der Hilfetext eines Schalters: seine Zeile und die eingerueckten Folgezeilen bis zum naechsten Schalter. */
function schalterHilfe(hilfe: string, schalter: string): string {
  const zeilen = hilfe.split('\n');
  const i = zeilen.findIndex((z) => new RegExp(`^\\s+(?:-\\w, )?${schalter}(?:[\\s=,]|$)`).test(z));
  if (i < 0) return '';
  const raus = [zeilen[i]];
  for (const z of zeilen.slice(i + 1)) {
    if (/^\s*-/.test(z) || !z.trim()) break;
    raus.push(z);
  }
  return raus.join(' ');
}

export function rechteFormAusHilfe(code: number | null, hilfe: string): RechteForm | null {
  if (code !== 0 || !/--werkzeuge\b/.test(hilfe)) return null;
  const form = (schalter: string): Listenform => {
    const name = schalter.replace(/^--/, '').toUpperCase().replace(/-/g, '_');
    if (new RegExp(`${schalter}\\s+(?:${name}\\s+)?\\[${name}\\s+\\.\\.\\.\\]`).test(hilfe)) return 'nargs';
    return /mehrfach|wiederhol|repeat/i.test(schalterHilfe(hilfe, schalter)) ? 'mehrfach' : 'komma';
  };
  return { werkzeuge: form('--werkzeuge'), bash: form('--bash'), skills: form('--skills'), ohneBash: /--ohne-bash\b/.test(hilfe),
    welt: /\s--welt\b/.test(hilfe) ? 'schalter' : 'argument' };
}

export interface RechteWunsch { werkzeuge?: string[]; bash?: string[]; skills?: string[] }

/** Die Befehlszeile von `wb-agent rechte <welt> <agent> --werkzeuge … --bash … --skills …` in der gelesenen Form. */
export function rechteArgs(ort: string, agent: string, r: RechteWunsch, form: RechteForm, absender: string): string[] {
  const args = form.welt === 'schalter' ? ['agent', 'rechte', agent, `--welt=${ort}`] : ['agent', 'rechte', ort, agent];
  const liste = (schalter: string, werte: string[] | undefined, wie: Listenform): void => {
    if (!werte) return;
    if (wie === 'nargs') args.push(schalter, ...werte);
    else if (wie === 'mehrfach') args.push(...werte.map((w) => `${schalter}=${w}`));
    else args.push(`${schalter}=${werte.join(',')}`);
  };
  liste('--werkzeuge', r.werkzeuge, form.werkzeuge);
  if (r.bash && !r.bash.length && form.bash !== 'komma') args.push(form.ohneBash ? '--ohne-bash' : '--bash=');
  else liste('--bash', r.bash, form.bash);
  liste('--skills', r.skills, form.skills);
  args.push(`--absender=${absender}`, '--json');
  return args;
}

/** Was das Profil nach `agent rechte` anders traegt als gewuenscht; leer, wenn es passt. Bash und die Dienstwegmuster gibt die Bibliothek selbst dazu. */
export function rechteAbweichung(r: RechteWunsch, a: Pick<WeltAgent, 'werkzeuge' | 'bash' | 'skills'>): string {
  const gleich = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));
  const teile: string[] = [];
  if (r.werkzeuge && !gleich(r.werkzeuge.filter((w) => w !== 'Bash'), a.werkzeuge.filter((w) => w !== 'Bash'))) teile.push(`Werkzeuge ${a.werkzeuge.join(', ') || 'keine'}`);
  if (r.bash && !r.bash.every((m) => a.bash.includes(m))) teile.push(`Bash-Muster ohne ${r.bash.filter((m) => !a.bash.includes(m)).join(' · ')}`);
  if (r.skills && !gleich(r.skills, a.skills)) teile.push(`Skills ${a.skills.join(', ') || 'keine'}`);
  return teile.join('; ');
}

/** Wie ein Zugang der Art `web` entsteht -- der Satz, den beide Oberflaechen ohne einen zeigen. */
export function webZugangSatz(ablage: string): string {
  return `WebFetch und WebSearch gibt es erst, wenn die Welt einen Zugang der Art web hat. Einrichten: wb-welt zugang ${ablage} hinzufuegen --art web --name netz --bestaetigt`;
}

export const WEB_WERKZEUGE = ['WebFetch', 'WebSearch'];

/** Die Modellliste fuer die Prompts: die verfuegbaren Modelle der Welt, sonst die Registry. */
export function promptModelle(welt: WeltModell[] | null, registry: ModellZeile[]): ModellZeile[] {
  if (!welt) return registry;
  return welt.filter((m) => m.verfuegbar).map((m) => ({
    kennung: m.id, harness: m.harness,
    aufgabe: registry.find((r) => r.kennung === m.id || r.kennung.split(':')[0] === m.id.split(':')[0])?.aufgabe ?? '',
  }));
}

/** Ein Befehl `welt:<handlung> <JSON-Objekt>`. */
export const WELT_HANDLUNGEN = ['senden', 'antworten', 'zuruecknehmen', 'pausieren', 'fortsetzen', 'stoppen', 'ticket',
  'zurueckgeben', 'profil', 'gedaechtnis', 'gelesen', 'quittieren', 'vorschlag', 'gespraech', 'entwurf', 'anlegen',
  'skill_abnehmen', 'skill_ablehnen', 'neu', 'umziehen', 'maschinen', 'gewaehlt', 'rechte', 'vergessen'] as const;
export type WeltHandlung = (typeof WELT_HANDLUNGEN)[number];

export function weltBefehlLesen(befehl: string): { handlung: WeltHandlung; daten: Record<string, unknown> } | { fehler: string } {
  const m = befehl.trim().match(/^welt:([a-z_]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { fehler: `Befehl nicht lesbar: „${befehl.slice(0, 80)}“ -- erwartet welt:<handlung> <JSON>` };
  if (!(WELT_HANDLUNGEN as readonly string[]).includes(m[1])) return { fehler: `unbekannte Handlung ${m[1]} (erlaubt: ${WELT_HANDLUNGEN.join(', ')})` };
  let daten: unknown = {};
  try {
    daten = m[2] ? JSON.parse(m[2]) : {};
  } catch {
    return { fehler: `Die Angaben zu welt:${m[1]} sind kein JSON: ${m[2].slice(0, 120)}` };
  }
  if (!daten || typeof daten !== 'object' || Array.isArray(daten)) return { fehler: `Die Angaben zu welt:${m[1]} sind kein Objekt.` };
  return { handlung: m[1] as WeltHandlung, daten: daten as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Die Quelle
// ---------------------------------------------------------------------------

function kurz(l: Lauf): string {
  const zeile = l.err.trim().split('\n').filter(Boolean).pop() ?? '';
  return (l.fehler || zeile.replace(/^agents: FEHLER - /, '') || l.out.trim().split('\n').pop() || `Exit ${l.code}`).slice(0, 300);
}

function jsonAus<T>(l: Lauf): T | null {
  try {
    return JSON.parse(l.out) as T;
  } catch {
    return null;
  }
}

interface Gemerkt { welt: Welt; gelesen: number; schmutzig: boolean }

/**
 * Auftrag agentsform: die Bash-Muster, die die Bibliothek jedem Entwurf je Stufe gibt -- gefragt bei
 * `validate_agent_draft` selbst, damit die Oberflaeche zeigt, was der Dienstweg ohnehin bekommt, auch wenn
 * sich die Vorgabe aendert. Argument: der Ordner der Datenbibliothek.
 */
const BASH_VORGABE_PROBE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import agents_data as a',
  'raus = {}',
  'for stufe in a.STAGES:',
  '    entwurf = {"id": "probe", "stage": stufe, "specialty": "Probe.", "tools": ["Read"]}',
  '    if stufe != "hauptagent":',
  '        entwurf["team"] = "probe"',
  '    try:',
  '        raus[stufe] = list(a.validate_agent_draft(entwurf)["bash"])',
  '    except Exception:',
  '        pass',
  'print(json.dumps(raus))',
].join('\n');

/** `agents_weltauftrag.py lesen`: Ansicht, Skills und Traeger einer Fernwelt in einem Aufruf. */
interface RohLesen {
  ansicht: RohAnsicht; skills: RohSkillAnsicht | null; skills_fehler?: string;
  traeger?: { eingerichtet?: boolean; laeuft?: boolean | null };
  /** Auftrag agentaktiv: das Lebenszeichen je Agent, nur mit eingerichtetem Traeger. */
  zug?: { agenten?: Record<string, unknown>; zug_fehler?: string };
}
interface RohAnlegen { pfad: string; projekt: string | null; name: string; vorhanden: boolean; traeger?: { eingerichtet?: boolean; fehler?: string } }

export class WeltenQuelle {
  private funde: RohFund[] = [];
  private fundZeit = 0;
  private fundSchluessel = '';
  private fundFehler = '';
  private gemerkt = new Map<string, Gemerkt>();
  private waechter = new Map<string, FSWatcher>();
  private geladen = false;
  private vorlagen: WeltVorlage[] = [];
  private modelle: ModellZeile[] = [];
  private katalogZeit = 0;
  private katalogFehler: { quelle: string; text: string }[] = [];
  private gespraeche = new GespraechSpeicher();
  private readonly fern: FernWeg;
  /** Die Maschinen aus `agents.maschinen` (aufgaben.ts); ohne Angabe die Vorgabe mac und peer. */
  private angaben: MaschinenAngabe[] = [{ name: 'mac', ssh: 'mac', standard: false }, { name: 'peer', ssh: 'peer', standard: true }];
  private fernFunde = new Map<string, RohFund[]>();
  private fernFindenZeit = new Map<string, number>();
  private fernFindenFehler = new Map<string, string>();
  private fernFindenLaeuft = new Set<string>();
  private fernLesenLaeuft = new Set<string>();
  /** Die Welt, die eine Oberflaeche gerade zeigt (`welt:gewaehlt`): als Fernwelt liest sie der Takt oefter. */
  private gewaehlt = '';
  /** Welten, die gerade umziehen: an sie geht keine andere Handlung. */
  private umzug = new Set<string>();
  /** Auftrag agentaktiv: was das Wecken nach dem letzten Senden an einen Agenten ergab, je Welt und Agent. */
  private weckStand = new Map<string, Record<string, string>>();
  /** Auftrag agentsform: je Maschine, ob und wie ihre Bibliothek `agent rechte` kennt, und wann das gefragt wurde. */
  private rechteFormen = new Map<string, { form: RechteForm | null; zeit: number }>();
  private rechteFrageLaeuft = new Set<string>();
  /** Die Bash-Muster des Dienstwegs je Stufe aus der Bibliothek dieser Maschine. */
  private bashVorgabe: Record<string, string[]> = {};

  private geweckt(pfad: string): Record<string, string> {
    return this.weckStand.get(pfad) ?? {};
  }

  constructor(private readonly opt: WeltenOptionen, private readonly lauf: Laeufer, private readonly geaendert: () => void) {
    this.fern = new FernWeg(opt.fern);
  }

  /** Die Maschinen aus den Einstellungen, jeden Takt neu (aufgaben.ts `maschinenAngaben`). */
  maschinenSetzen(angaben: MaschinenAngabe[]): void {
    if (angaben.length) this.angaben = angaben;
  }

  private get eigene(): string {
    return this.opt.fern.eigene;
  }

  private angabe(name: string): MaschinenAngabe {
    return this.angaben.find((m) => m.name === name) ?? { name, ssh: name, standard: false };
  }

  /** Kann auf dieser Maschine ein Traeger laufen? Er braucht systemd: die eigene nur unter Linux, eine Fernmaschine ausser dem Mac. */
  private traegerMoeglich(name: string): boolean {
    return name === this.eigene ? process.platform === 'linux' : name !== 'mac';
  }

  /** Die Maschinen, auf denen eine Welt eingetragen ist: nur sie fragt der Takt ab. Andere erst auf ausdrueckliche Probe. */
  private fernMaschinen(): MaschinenAngabe[] {
    const namen = [...new Set(registerLesen(this.opt.fern.register).map((e) => e.maschine))].filter((n) => n !== this.eigene);
    return namen.map((n) => this.angabe(n));
  }

  private alleFernFunde(): RohFund[] {
    return [...this.fernFunde.values()].flat();
  }

  private fund(schluessel: string): RohFund | undefined {
    return this.funde.find((f) => f.path === schluessel) ?? this.alleFernFunde().find((f) => fundSchluessel(f) === schluessel);
  }

  /** Die Projektordner aus den Code-Sitzungen beim letzten Takt -- das Finden nach `welt:neu` braucht sie. */
  private sitzungsProjekte: string[] = [];
  private gemerkteProjekte: string[] | null = null;

  static leer(): WeltenNutzlast {
    return { geladen: false, fehler: [], welten: [], datenbibliothek: '', vorlagen: [], modelle: [], entwurf_modelle: [...ENTWURF_MODELLE], global_pfad: '', maschinen: [], maschine_vorgabe: '',
      gemerkte_projekte: [], bash_vorgabe: {} };
  }

  /** Die Ordner, in denen hier eine Welt angelegt wurde; eine kaputte oder fehlende Datei heisst: keine. */
  private bekannteProjekte(): string[] {
    if (this.gemerkteProjekte) return this.gemerkteProjekte;
    let liste: string[] = [];
    try {
      const roh = JSON.parse(readFileSync(this.opt.projekteDatei, 'utf8')) as unknown;
      if (Array.isArray(roh)) liste = roh.filter((p): p is string => typeof p === 'string' && isAbsolute(p));
    } catch {
      // Noch keine Datei: noch keine Welt aus der Oberflaeche.
    }
    this.gemerkteProjekte = liste;
    return liste;
  }

  private projektMerken(ordner: string): void {
    const liste = this.bekannteProjekte();
    if (liste.includes(ordner) || !this.opt.projekteDatei) return;
    this.projekteSchreiben([...liste, ordner].sort());
  }

  /** Die gemerkten Ordner schreiben; ein Fehler laesst die Liste im Speicher gelten, bis der Kern neu startet. */
  private projekteSchreiben(neu: string[]): boolean {
    this.gemerkteProjekte = neu;
    try {
      mkdirSync(dirname(this.opt.projekteDatei), { recursive: true });
      const tmp = `${this.opt.projekteDatei}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(neu, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.opt.projekteDatei);
      return true;
    } catch {
      // Ohne Datei bleibt die Welt bis zum Neustart des Kerns in der Liste; gefunden wird sie danach nur unter einer Wurzel.
      return false;
    }
  }

  /**
   * `welt:vergessen {"ordner"}`: einen gemerkten Projektordner aus `welten-projekte.json` nehmen. Der Ordner und
   * seine Welt bleiben unberuehrt; die Werkbank sucht dort nur nicht mehr von selbst. Ohne `bestaetigt` fragt sie zurueck.
   */
  private async vergessen(daten: Record<string, unknown>, bestaetigt: boolean,
    antwort: (ok: boolean, meldung: string, mehr?: Partial<WeltenHandlungsErgebnis>) => WeltenHandlungsErgebnis): Promise<WeltenHandlungsErgebnis> {
    const ordner = s(daten.ordner).trim();
    const liste = this.bekannteProjekte();
    if (!ordner || !liste.includes(ordner)) return antwort(false, `„${ordner}“ steht nicht in der Liste der gemerkten Projektordner.`);
    const bleibt = this.opt.wurzeln.some((w) => dirname(ordner) === resolve(w)) || this.sitzungsProjekte.includes(ordner);
    if (!bestaetigt) {
      return antwort(false, 'Rückfrage', {
        rueckfrage: `${basename(ordner)} aus der Liste der Welten entfernen?`,
        warnungen: [
          `Der Ordner ${ordner} und seine Welt bleiben, wie sie sind; die Werkbank sucht dort nur nicht mehr von selbst.`,
          ...(bleibt ? ['Er liegt unter einer Wurzel oder hat eine laufende Sitzung; die Welt erscheint deshalb weiter im Menü.'] : []),
        ],
      });
    }
    if (!this.projekteSchreiben(liste.filter((p) => p !== ordner))) {
      return antwort(false, `${this.opt.projekteDatei} ließ sich nicht schreiben; ${basename(ordner)} fehlt nur bis zum Neustart.`);
    }
    await this.finden(this.projekteZumFinden());
    this.fundSchluessel = this.projekteZumFinden().join('\n');
    this.geaendert();
    return antwort(true, `${basename(ordner)} steht nicht mehr in der Liste; der Ordner bleibt, wie er ist.`);
  }

  private projekteZumFinden(): string[] {
    return [...new Set([...this.sitzungsProjekte, ...this.bekannteProjekte()].filter(Boolean))].sort();
  }

  stop(): void {
    for (const w of this.waechter.values()) w.close();
    this.waechter.clear();
    entwurfAbraeumen();
    this.fern.stop();
  }

  /** Vorlagen und Modellliste fuer das Anlege-Menue, so selten wie das Finden der Welten. */
  private async katalog(): Promise<void> {
    if (this.katalogZeit && Date.now() - this.katalogZeit < this.opt.findenMs) return;
    this.katalogZeit = Date.now();
    const fehler: { quelle: string; text: string }[] = [];
    const v = await this.daten(['agent', 'vorlagen', '--json']);
    const vorlagen = jsonAus<WeltVorlage[]>(v);
    if (v.code === 0 && Array.isArray(vorlagen)) this.vorlagen = vorlagen;
    else fehler.push({ quelle: 'wb-agent vorlagen', text: kurz(v) });
    const t = await this.lauf(this.opt.entwurf.wbState, ['models', 'table'], this.opt.fristMs);
    if (t.code === 0) this.modelle = modelleAusTabelle(t.out);
    else fehler.push({ quelle: 'wb-state models table', text: kurz(t) });
    // Auftrag agentsform: kennt die Bibliothek hier `agent rechte`, und welche Bash-Muster gibt sie jeder Stufe?
    const [h, b] = await Promise.all([
      this.daten(['agent', 'rechte', '--help']),
      this.lauf(this.opt.python, ['-c', BASH_VORGABE_PROBE, dirname(this.opt.daten)], this.opt.fristMs),
    ]);
    this.rechteFormen.set(this.eigene, { form: rechteFormAusHilfe(h.code, `${h.out}\n${h.err}`), zeit: Date.now() });
    const vorgabe = b.code === 0 ? jsonAus<Record<string, unknown>>(b) : null;
    if (vorgabe) this.bashVorgabe = Object.fromEntries(Object.entries(vorgabe).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(String)]));
    this.katalogFehler = fehler;
  }

  /** Auftrag agentsform: ob die Bibliothek auf der Maschine einer Welt `agent rechte` kennt; unbekannt heisst nein. */
  private rechteFormFuer(w: Pick<Welt, 'fern' | 'maschine'>): RechteForm | null {
    return this.rechteFormen.get(w.fern ? w.maschine : this.eigene)?.form ?? null;
  }

  /** Die Hilfe von `agent rechte` auf einer Agent-Maschine fragen, so selten wie das Finden; laeuft neben dem Takt. */
  private rechteFernFragen(m: MaschinenAngabe): void {
    const alt = this.rechteFormen.get(m.name);
    if (this.rechteFrageLaeuft.has(m.name) || (alt && Date.now() - alt.zeit < this.opt.findenMs)) return;
    this.rechteFrageLaeuft.add(m.name);
    void this.fern.auftrag<{ code?: number; out?: string; err?: string }>(m.name, m.ssh, { befehl: 'ausfuehren', skript: 'agents_data.py', argv: ['agent', 'rechte', '--help'] })
      .then((r) => {
        // Eine nicht erreichbare Maschine laesst den letzten Stand stehen und fragt beim naechsten Takt wieder.
        if (!r.ok) return;
        const vorher = alt?.form ?? null;
        const form = rechteFormAusHilfe(typeof r.daten.code === 'number' ? r.daten.code : null, `${r.daten.out ?? ''}\n${r.daten.err ?? ''}`);
        this.rechteFormen.set(m.name, { form, zeit: Date.now() });
        if (JSON.stringify(form) !== JSON.stringify(vorher)) this.geaendert();
      })
      .finally(() => this.rechteFrageLaeuft.delete(m.name));
  }

  private daten(args: string[]): Promise<Lauf> {
    return this.lauf(this.opt.python, [this.opt.daten, ...args], this.opt.fristMs);
  }

  /** Ein Modell fuer Vorschlag oder Gespraech: Registry-Eintrag und Deckel ueber `wb-state`. */
  private async modellAufloesen(wahl: string, wofuer: string): Promise<ModellWahl | { fehler: string }> {
    if (!(ENTWURF_MODELLE as readonly string[]).includes(wahl)) return { fehler: `${wofuer} ${ENTWURF_MODELLE.join(' oder ')}.` };
    const get = await this.lauf(this.opt.entwurf.wbState, ['models', 'get', wahl.split(':')[0]], this.opt.fristMs);
    const eintrag = jsonAus<{ id?: string }>(get);
    if (get.code !== 0 || !eintrag) return { fehler: `Modell ${wahl} nicht in der Registry: ${kurz(get)}` };
    const cap = await this.lauf(this.opt.entwurf.wbState, ['models', 'cap', s(eintrag.id), '--json'], this.opt.fristMs);
    return modellWaehlen(wahl, eintrag, jsonAus(cap));
  }

  /** fs.watch auf die ganze Welt: eine Aenderung liest nur diese Welt neu. */
  private beobachten(pfad: string): void {
    if (this.waechter.has(pfad) || !existsSync(pfad)) return;
    try {
      const w = watch(pfad, { recursive: true }, () => {
        const g = this.gemerkt.get(pfad);
        if (g) g.schmutzig = true;
        this.geaendert();
      });
      w.on('error', () => {
        w.close();
        this.waechter.delete(pfad);
      });
      this.waechter.set(pfad, w);
    } catch {
      // Ohne Waechter liest der Takt die Welt spaetestens nach `nachlesenMs`.
    }
  }

  private async finden(projekte: string[]): Promise<void> {
    const args = ['welt', 'finden', '--json'];
    for (const w of this.opt.wurzeln) args.push(`--wurzel=${w}`);
    for (const p of projekte) args.push(`--projekt=${p}`);
    if (this.opt.global) args.push(`--global=${this.opt.global}`);
    else args.push('--ohne-global');
    // Ohne Wurzel und ohne Projekt nimmt `finden` ~/AI -- das soll eine leere Wurzelliste nicht heissen.
    if (!this.opt.wurzeln.length && !projekte.length) args.push('--wurzel=');
    const l = await this.daten(args);
    const d = l.code === 0 ? jsonAus<RohFund[]>(l) : null;
    if (!d) {
      this.fundFehler = kurz(l);
      return;
    }
    this.fundFehler = '';
    this.funde = d;
    this.fundZeit = Date.now();
  }

  private async lesen(fund: RohFund): Promise<void> {
    if (fund.error) {
      this.gemerkt.set(fund.path, { welt: weltMitFehler(fund, fund.error), gelesen: Date.now(), schmutzig: false });
      return;
    }
    this.beobachten(fund.path);
    // Vor dem Lesen sauber: eine Aenderung waehrend des Lesens macht die Welt wieder schmutzig.
    const alt = this.gemerkt.get(fund.path);
    if (alt) alt.schmutzig = false;
    const skillSkript = join(dirname(this.opt.daten), 'agents_skills_ansicht.py');
    // Auftrag agentaktiv: mit `traeger.json` ein dritter Aufruf, das Lebenszeichen je Agent.
    const konfig = join(fund.path, 'traeger.json');
    const mitTraeger = existsSync(konfig);
    const [l, sl, zl] = await Promise.all([
      this.daten(['welt', 'ansicht', fund.path, `--grenze=${this.opt.grenze}`, '--json']),
      existsSync(skillSkript)
        ? this.lauf(this.opt.python, [skillSkript, fund.path, '--json'], this.opt.fristMs)
        : Promise.resolve<Lauf>({ code: null, out: '', err: '', fehler: `agents_skills_ansicht.py fehlt neben ${this.opt.daten}` }),
      mitTraeger && this.opt.traeger
        ? this.lauf(this.opt.python, [this.opt.traeger, 'status', '--konfig', konfig, '--nur-zug'], this.opt.fristMs)
        : Promise.resolve<Lauf | null>(null),
    ]);
    const roh = l.code === 0 ? jsonAus<RohAnsicht>(l) : null;
    const rohSkills = sl.code === 0 ? jsonAus<RohSkillAnsicht>(sl) : null;
    const gelesen = roh ? weltAus(roh, fund, this.opt.grenze) : weltMitFehler(fund, `wb-welt ansicht: ${kurz(l)}`);
    const rohZug = zl && zl.code === 0 ? jsonAus<{ agenten?: Record<string, unknown> }>(zl)?.agenten ?? null : null;
    const zugFehler = !mitTraeger || rohZug ? '' : zl ? `agents_traeger.py status: ${kurz(zl)}` : 'agents_traeger.py nicht gefunden';
    const welt: Welt = zugEinsetzen({
      ...(roh ? skillsEinsetzen(gelesen, rohSkills, rohSkills ? '' : `Skills: ${kurz(sl)}`) : gelesen),
      maschine: this.eigene, fern: false, ablage: fund.path,
      traeger: { eingerichtet: mitTraeger, laeuft: null, moeglich: this.traegerMoeglich(this.eigene), zug_fehler: zugFehler },
    }, rohZug, this.geweckt(fund.path));
    const jetzt = this.gemerkt.get(fund.path);
    this.gemerkt.set(fund.path, { welt, gelesen: Date.now(), schmutzig: jetzt?.schmutzig ?? false });
  }

  /** Die Wurzeln und die globale Welt als `~/…` fuer eine andere Maschine: derselbe Pfad relativ zum Home. */
  private fernOrte(): { wurzeln: string[]; global: string | null } {
    const home = process.env.HOME ?? '';
    return {
      wurzeln: this.opt.wurzeln.map((w) => homeRelativ(resolve(w), home)).filter((w): w is string => !!w),
      global: this.opt.global ? homeRelativ(resolve(this.opt.global), home) : null,
    };
  }

  /** `welt finden` auf einer Maschine; eingetragene Welten, die das Finden nicht sieht, bleiben mit ihrem Pfad stehen. */
  private async fernFinden(m: MaschinenAngabe): Promise<void> {
    const eintraege = registerLesen(this.opt.fern.register).filter((e) => e.maschine === m.name);
    const orte = this.fernOrte();
    const r = await this.fern.auftrag<{ welten: RohFund[] }>(m.name, m.ssh, {
      befehl: 'finden', wurzeln: orte.wurzeln, projekte: eintraege.map((e) => e.projekt).filter(Boolean), global: orte.global,
    });
    const funde: RohFund[] = r.ok && Array.isArray(r.daten.welten)
      ? r.daten.welten.map((f) => ({ ...f, maschine: m.name }))
      : [...(this.fernFunde.get(m.name) ?? [])];
    for (const e of eintraege) {
      if (funde.some((f) => f.path === e.pfad)) continue;
      funde.push({ path: e.pfad, kind: 'project', project: e.projekt, id: null, name: basename(e.projekt ?? e.pfad), state: null, error: null, maschine: m.name });
    }
    this.fernFunde.set(m.name, funde);
    this.fernFindenZeit.set(m.name, Date.now());
    this.fernFindenFehler.set(m.name, r.ok ? '' : r.text);
  }

  /** Eine Fernwelt lesen. Faellt die Maschine aus, bleibt der letzte Stand stehen und sagt, seit wann sie fehlt. */
  private async fernLesen(fund: RohFund): Promise<void> {
    const schluessel = fundSchluessel(fund);
    const m = this.angabe(fund.maschine ?? '');
    const alt = this.gemerkt.get(schluessel);
    if (alt) alt.schmutzig = false;
    const r = await this.fern.auftrag<RohLesen>(m.name, m.ssh, { befehl: 'lesen', welt: fund.path, grenze: this.opt.grenze });
    const stand = this.fern.maschinenStand(m.name);
    const ort = (w: Welt, traeger?: RohLesen['traeger'], zug?: RohLesen['zug']): Welt => zugEinsetzen({
      ...w, pfad: schluessel, maschine: m.name, fern: true, ablage: fund.path,
      verbindung: r.ok || r.verbindung ? { ok: true, seit: null, text: '' } : { ok: false, seit: stand.seit, text: r.text },
      traeger: traeger
        ? {
          eingerichtet: traeger.eingerichtet === true, laeuft: typeof traeger.laeuft === 'boolean' ? traeger.laeuft : null, moeglich: this.traegerMoeglich(m.name),
          zug_fehler: zug?.agenten ? '' : s(zug?.zug_fehler) || (traeger.eingerichtet ? 'agents_weltauftrag.py lieferte kein Lebenszeichen (Laufzeit dort aktuell?)' : ''),
        }
        : alt?.welt.traeger ?? { eingerichtet: false, laeuft: null, moeglich: this.traegerMoeglich(m.name), zug_fehler: '' },
    }, zug?.agenten ?? null, this.geweckt(schluessel));
    let welt: Welt;
    if (r.ok && r.daten?.ansicht) {
      const gelesen = weltAus(r.daten.ansicht, fund, this.opt.grenze);
      welt = ort(skillsEinsetzen(gelesen, r.daten.skills ?? null, r.daten.skills ? '' : `Skills: ${r.daten.skills_fehler || 'nicht lesbar'}`), r.daten.traeger, r.daten.zug);
    } else if (!r.ok && !r.verbindung && alt && alt.welt.gelesen) {
      welt = ort(alt.welt);
    } else {
      const text = r.ok ? 'agents_weltauftrag.py lieferte keine Ansicht' : r.verbindung ? `wb-welt ansicht: ${r.text}` : `${m.name} nicht erreichbar: ${r.text}`;
      welt = ort(weltMitFehler(fund, text));
    }
    const jetzt = this.gemerkt.get(schluessel);
    this.gemerkt.set(schluessel, { welt, gelesen: Date.now(), schmutzig: jetzt?.schmutzig ?? false });
  }

  /** Der Takt der Fernwelten: Finden und Lesen laufen im Hintergrund; ist eins fertig, stoesst es den naechsten Takt an. */
  private fernTakt(): void {
    const jetzt = Date.now();
    for (const m of this.fernMaschinen()) this.rechteFernFragen(m);
    for (const m of this.fernMaschinen()) {
      if (this.fernFindenLaeuft.has(m.name) || jetzt - (this.fernFindenZeit.get(m.name) ?? 0) < this.opt.findenMs) continue;
      this.fernFindenLaeuft.add(m.name);
      void this.fernFinden(m).finally(() => {
        this.fernFindenLaeuft.delete(m.name);
        this.geaendert();
      });
    }
    const aktiv = new Set(this.fernMaschinen().map((m) => m.name));
    for (const f of this.alleFernFunde()) {
      const k = fundSchluessel(f);
      if (!aktiv.has(f.maschine ?? '') || this.fernLesenLaeuft.has(k) || this.umzug.has(k)) continue;
      const g = this.gemerkt.get(k);
      const takt = k === this.gewaehlt ? this.opt.fern.taktMs : this.opt.nachlesenMs;
      if (g && !g.schmutzig && jetzt - g.gelesen < takt) continue;
      this.fernLesenLaeuft.add(k);
      void this.fernLesen(f).finally(() => {
        this.fernLesenLaeuft.delete(k);
        this.geaendert();
      });
    }
  }

  /** Die Maschinen fuer die Nutzlast: eigene zuerst, mit Verbindung, Welten und eingerichteten Traegern. */
  private maschinenNutzlast(): WeltMaschine[] {
    const namen = [this.eigene, ...this.angaben.map((m) => m.name).filter((n) => n !== this.eigene)];
    for (const e of registerLesen(this.opt.fern.register)) if (!namen.includes(e.maschine)) namen.push(e.maschine);
    const welten = [...this.gemerkt.values()].map((g) => g.welt);
    return namen.map((name) => {
      const a = this.angabe(name);
      const st = this.fern.maschinenStand(name);
      const eigene = name === this.eigene;
      const hier = welten.filter((w) => (w.fern ? w.maschine === name : eigene));
      return {
        name, ssh: a.ssh, eigene, standard: a.standard, traeger: this.traegerMoeglich(name),
        erreichbar: eigene ? true : st.erreichbar, seit: eigene ? null : st.seit, text: eigene ? '' : st.text,
        welten: hier.length, traeger_eingerichtet: hier.filter((w) => w.traeger.eingerichtet).length,
      };
    });
  }

  private maschineVorgabe(): string {
    return this.angaben.find((m) => m.standard)?.name ?? this.eigene;
  }

  /** Ein Takt: Welten finden (selten), jede geaenderte oder alte Welt neu lesen. */
  async sammeln(projekte: string[]): Promise<WeltenNutzlast> {
    const fehler: WeltenNutzlast['fehler'] = [];
    if (!this.opt.daten || !existsSync(this.opt.daten)) {
      return { geladen: true, fehler: [{ quelle: 'agents_data.py', text: `Datenbibliothek nicht gefunden${this.opt.daten ? `: ${this.opt.daten}` : ''} (AWB_AGENTS_DATA)` }], welten: [], datenbibliothek: '',
        vorlagen: [], modelle: [], entwurf_modelle: [...ENTWURF_MODELLE], global_pfad: this.opt.global, maschinen: this.maschinenNutzlast(), maschine_vorgabe: this.maschineVorgabe(),
        gemerkte_projekte: this.bekannteProjekte(), bash_vorgabe: {} };
    }
    this.sitzungsProjekte = [...new Set(projekte.filter(Boolean))];
    const liste = this.projekteZumFinden();
    const schluessel = liste.join('\n');
    if (!this.fundZeit || Date.now() - this.fundZeit >= this.opt.findenMs || schluessel !== this.fundSchluessel) {
      this.fundSchluessel = schluessel;
      await this.finden(liste);
    }
    if (this.fundFehler) fehler.push({ quelle: 'wb-welt finden', text: this.fundFehler });
    await this.katalog();
    fehler.push(...this.katalogFehler);
    // Eine Maschine, auf der keine Welt mehr eingetragen ist, fragt der Takt nicht mehr ab.
    const aktiv = new Set(this.fernMaschinen().map((m) => m.name));
    for (const name of [...this.fernFunde.keys()]) if (!aktiv.has(name)) this.fernFunde.delete(name);
    for (const name of aktiv) {
      const f = this.fernFindenFehler.get(name);
      if (f) fehler.push({ quelle: `wb-welt finden auf ${name}`, text: f });
    }
    const pfade = new Set([...this.funde, ...this.alleFernFunde()].map(fundSchluessel));
    for (const pfad of [...this.gemerkt.keys()]) {
      if (pfade.has(pfad)) continue;
      this.gemerkt.delete(pfad);
      this.waechter.get(pfad)?.close();
      this.waechter.delete(pfad);
    }
    const jetzt = Date.now();
    await Promise.all(this.funde.map(async (f) => {
      const g = this.gemerkt.get(f.path);
      // Auftrag agentaktiv: der Zustand des Traegers liegt nicht in der Welt, fs.watch sieht einen Zugbeginn nicht.
      // Laeuft ein Zug oder wartet eine Zustellung, liest der Takt die Welt so oft wie die gewaehlte Fernwelt.
      // Ein Status, der gerade nicht lesbar war, fragt der Takt ebenso oft wieder.
      const takt = g && (g.welt.traeger.zug_fehler || g.welt.agenten.some((a) => a.zug?.laeuft || a.zug?.zustellung_offen))
        ? Math.min(this.opt.nachlesenMs, this.opt.fern.taktMs) : this.opt.nachlesenMs;
      if (g && !g.schmutzig && jetzt - g.gelesen < takt) return;
      await this.lesen(f);
    }));
    this.fernTakt();
    if (this.fundZeit) this.geladen = true;
    return {
      geladen: this.geladen,
      fehler,
      welten: [...this.funde, ...this.alleFernFunde()].map((f) => this.gemerkt.get(fundSchluessel(f))?.welt).filter((w): w is Welt => !!w)
        .map((w) => ({ ...w, rechte_aenderbar: !!this.rechteFormFuer(w) })),
      datenbibliothek: this.opt.daten,
      vorlagen: this.vorlagen,
      modelle: this.modelle,
      entwurf_modelle: [...ENTWURF_MODELLE],
      global_pfad: this.opt.global,
      maschinen: this.maschinenNutzlast(),
      maschine_vorgabe: this.maschineVorgabe(),
      gemerkte_projekte: this.bekannteProjekte(),
      bash_vorgabe: this.bashVorgabe,
    };
  }

  /** Eine Welt sofort neu lesen -- nach einer Handlung, damit die Antwort schon den neuen Stand traegt. */
  private async nachHandlung(pfad: string): Promise<void> {
    const fund = this.fund(pfad);
    if (fund?.maschine) await this.fernLesen(fund);
    else if (fund) await this.lesen(fund);
    this.geaendert();
  }

  /**
   * Die Datenbibliothek (oder `agents_skills.py`) fuer eine Welt: lokal direkt, fern als `ausfuehren`
   * ueber ssh. `wecken` weckt nach Exit 0 den Traeger der Welt, wenn sie eine `traeger.json` hat.
   * Grosse Texte (Gedaechtnis, Entwurf) gehen fern als Datei auf der Maschine der Welt.
   */
  private async datenFuer(welt: Welt, args: string[], opt: { skript?: 'agents_data.py' | 'agents_skills.py'; wecken?: boolean } = {}): Promise<Lauf & { weck: string; weckRoh: string }> {
    const skript = opt.skript ?? 'agents_data.py';
    if (!welt.fern) {
      const bin = skript === 'agents_data.py' ? this.opt.daten : join(dirname(this.opt.daten), skript);
      const l = await this.lauf(this.opt.python, [bin, ...args], this.opt.fristMs);
      let weck = '';
      let weckRoh = '';
      if (opt.wecken && l.code === 0 && existsSync(join(welt.ablage, 'traeger.json'))) {
        const w = await this.lauf(this.opt.python, [join(dirname(this.opt.daten), 'agents_weltauftrag.py'), 'wecken', welt.ablage], this.opt.fristMs);
        const r = jsonAus<{ wecken?: unknown; wecken_fehler?: unknown }>(w) ?? { wecken_fehler: kurz(w) };
        weck = weckSatz(r);
        weckRoh = weckWort(r);
      }
      return { ...l, weck, weckRoh };
    }
    const gedaechtnis = args[0] === 'agent' && args[1] === 'gedaechtnis';
    const argv = args.map((a): string | { datei: string; vor: string } => {
      if (gedaechtnis && a.startsWith('--text=')) return { datei: a.slice(7), vor: '--datei=' };
      if (a.startsWith('--entwurf=')) return { datei: a.slice(10), vor: '--entwurf-datei=' };
      return a;
    });
    const m = this.angabe(welt.maschine);
    const r = await this.fern.auftrag<{ code?: number; out?: string; err?: string; wecken?: unknown; wecken_fehler?: unknown }>(
      m.name, m.ssh, { befehl: 'ausfuehren', skript, argv, welt: welt.ablage, wecken: opt.wecken === true });
    if (!r.ok) {
      const text = r.verbindung ? r.text : `${m.name} nicht erreichbar: ${r.text}`;
      return { code: null, out: '', err: '', fehler: text, weck: '', weckRoh: '' };
    }
    const d = r.daten;
    return { code: typeof d.code === 'number' ? d.code : null, out: d.out ?? '', err: d.err ?? '', fehler: '', weck: weckSatz(d), weckRoh: weckWort(d) };
  }

  welt(pfad: string): Welt | null {
    const w = this.gemerkt.get(pfad)?.welt;
    return w ? { ...w, rechte_aenderbar: !!this.rechteFormFuer(w) } : null;
  }

  /**
   * `welt:neu`: eine Projektwelt in `<ordner>/.werkbank/agents` oder die globale Welt unter
   * `AWB_WELTEN_GLOBAL`, beide ohne Hauptagenten. Die Antwort traegt in `pfad` die Ablage,
   * damit die Oberflaeche die neue Welt gleich waehlt; gelesen ist sie dann schon.
   */
  private async weltAnlegen(daten: Record<string, unknown>): Promise<WeltenHandlungsErgebnis> {
    const ergebnis = (ok: boolean, meldung: string, pfad = ''): WeltenHandlungsErgebnis =>
      ({ ok, handlung: 'welt:neu', id: pfad, pfad, meldung });
    // Ohne Maschine oder mit der eigenen: hier. Die Vorgabe peer setzt die Oberflaeche, nicht der Kern --
    // ein Steuerkanal oder eine Suite ohne Angabe erreicht so nie eine fremde Maschine.
    const maschine = s(daten.maschine).trim();
    if (maschine && maschine !== this.eigene) return this.fernWeltAnlegen(daten, maschine);
    const global = s(daten.art) === 'global';
    let ablage: string;
    let name: string;
    let ordner = '';
    if (global) {
      if (!this.opt.global) return ergebnis(false, 'Für die globale Welt ist keine Ablage eingestellt (AWB_WELTEN_GLOBAL).');
      ablage = resolve(this.opt.global);
      name = 'Global';
      if (existsSync(join(ablage, 'world.json'))) return ergebnis(false, 'Die globale Welt gibt es schon; sie steht im Menü der Welten.', ablage);
    } else {
      const roh = s(daten.ordner).trim();
      if (!roh) return ergebnis(false, 'Der Projektordner fehlt.');
      if (!isAbsolute(roh)) return ergebnis(false, `Der Projektordner braucht einen absoluten Pfad: ${roh}`);
      try {
        // Der Pfad bleibt, wie ihn Sitzungen und Wurzeln schreiben (/var statt /private/var), damit
        // dieselbe Welt nicht unter zwei Pfaden erscheint. Nur ein Ordner, der selbst ein Symlink ist,
        // wird aufgeloest: die Bibliothek nimmt keine Welt unter einem Symlink an.
        ordner = resolve(roh);
        if (lstatSync(ordner).isSymbolicLink()) ordner = realpathSync(ordner);
        if (!statSync(ordner).isDirectory()) return ergebnis(false, `${roh} ist kein Ordner.`);
      } catch {
        return ergebnis(false, `Den Ordner ${roh} gibt es nicht.`);
      }
      const home = process.env.HOME ? resolve(process.env.HOME) : '';
      if (ordner === '/' || ordner === home) return ergebnis(false, 'Wähle den Ordner eines Projekts, nicht den Benutzerordner oder die Wurzel.');
      ablage = join(ordner, '.werkbank', 'agents');
      name = s(daten.name).trim() || basename(ordner);
      if (existsSync(join(ablage, 'world.json'))) {
        this.projektMerken(ordner);
        await this.nachAnlegen(ablage);
        return ergebnis(true, `In ${basename(ordner)} gibt es schon eine Welt; sie steht jetzt im Menü der Welten.`, ablage);
      }
    }
    const args = ['welt', 'neu', ablage, `--name=${name}`, '--ohne-hauptagent', '--json'];
    if (global) args.push('--global');
    const l = await this.daten(args);
    if (l.code !== 0) return ergebnis(false, kurz(l));
    if (ordner) this.projektMerken(ordner);
    let traeger = ` Auf ${this.eigene === 'mac' ? 'dem Mac' : this.eigene} läuft kein Träger, Agenten antworten hier nicht.`;
    if (this.traegerMoeglich(this.eigene)) {
      const e = await this.lauf(this.opt.python, [join(dirname(this.opt.daten), 'agents_weltauftrag.py'), 'einrichten', `--welt=${ablage}`], this.opt.fern.anlegenMs);
      const r = jsonAus<{ eingerichtet?: boolean; fehler?: string }>(e);
      traeger = e.code === 0 && r?.eingerichtet ? ' Träger eingerichtet.' : ` Träger nicht eingerichtet: ${r?.fehler ?? kurz(e)}`;
    }
    await this.nachAnlegen(ablage);
    return ergebnis(true, `Welt „${name}“ angelegt.${traeger} Als Nächstes: der Hauptagent.`, ablage);
  }

  /**
   * `welt:neu` mit einer Agent-Maschine: derselbe Pfad relativ zum Home dort (Mac `~/AI/<projekt>` ->
   * peer `~/AI/<projekt>`), ein Aufruf `anlegen` mit Einrichten des Traegers, danach steht die Welt im
   * Register und ist gelesen.
   */
  private async fernWeltAnlegen(daten: Record<string, unknown>, maschine: string): Promise<WeltenHandlungsErgebnis> {
    const ergebnis = (ok: boolean, meldung: string, pfad = ''): WeltenHandlungsErgebnis => ({ ok, handlung: 'welt:neu', id: pfad, pfad, meldung });
    if (!this.angaben.some((m) => m.name === maschine)) {
      return ergebnis(false, `„${maschine}“ ist keine Agent-Maschine (agents.maschinen kennt ${this.angaben.map((m) => m.name).join(', ')}).`);
    }
    const m = this.angabe(maschine);
    const home = process.env.HOME ? resolve(process.env.HOME) : '';
    const global = s(daten.art) === 'global';
    const job: Record<string, unknown> = { befehl: 'anlegen', art: global ? 'global' : 'projekt', einrichten: true };
    if (global) {
      const ort = this.opt.global ? homeRelativ(resolve(this.opt.global), home) : null;
      if (!ort) return ergebnis(false, `Die globale Welt liegt hier nicht unter dem Benutzerordner; auf ${maschine} gibt es dazu keinen gleichen Pfad.`);
      job.global = ort;
    } else {
      const roh = s(daten.ordner).trim();
      if (!roh) return ergebnis(false, 'Der Projektordner fehlt.');
      if (!isAbsolute(roh)) return ergebnis(false, `Der Projektordner braucht einen absoluten Pfad: ${roh}`);
      const ort = homeRelativ(resolve(roh), home);
      if (!ort) return ergebnis(false, `${roh} liegt nicht unter deinem Benutzerordner; auf ${maschine} gibt es dazu keinen gleichen Pfad.`);
      job.projekt = ort;
      const name = s(daten.name).trim();
      if (name) job.name = name;
    }
    const r = await this.fern.auftrag<RohAnlegen>(maschine, m.ssh, job, this.opt.fern.anlegenMs);
    if (!r.ok) return ergebnis(false, r.verbindung ? r.text : `${maschine} nicht erreichbar: ${r.text}`);
    const d = r.daten;
    try {
      registerEintragen(this.opt.fern.register, { maschine, pfad: d.pfad, projekt: d.projekt });
    } catch (e) {
      return ergebnis(false, `Die Welt steht auf ${maschine} unter ${d.pfad}, aber das Register ${this.opt.fern.register} liess sich nicht schreiben: ${(e as Error).message}`);
    }
    const schluessel = fernSchluessel(maschine, d.pfad);
    await this.fernFinden(m);
    const fund = this.alleFernFunde().find((f) => fundSchluessel(f) === schluessel);
    if (fund) await this.fernLesen(fund);
    this.geaendert();
    const t = d.traeger ?? {};
    const traeger = t.fehler ? ` Träger nicht eingerichtet: ${t.fehler}` : t.eingerichtet ? ' Träger eingerichtet.' : '';
    const name = global ? 'Global' : d.name;
    return ergebnis(true, d.vorhanden
      ? `In ${name} auf ${maschine} gibt es schon eine Welt; sie steht jetzt im Menü der Welten.${traeger}`
      : `Welt „${name}“ auf ${maschine} angelegt.${traeger} Als Nächstes: der Hauptagent.`, schluessel);
  }

  /** Nach dem Anlegen sofort finden und lesen, damit die Antwort schon eine gewaehlte Welt tragen kann. */
  private async nachAnlegen(ablage: string): Promise<void> {
    await this.finden(this.projekteZumFinden());
    this.fundSchluessel = this.projekteZumFinden().join('\n');
    const fund = this.funde.find((f) => resolve(f.path) === ablage);
    if (fund) await this.lesen(fund);
    this.geladen = true;
    this.geaendert();
  }

  /** `welt:maschinen`: jede Agent-Maschine einmal fragen (`hallo`), fuer die Vorgabe beim Anlegen und den Umzug. */
  private async maschinenPruefen(antwort: (ok: boolean, meldung: string, mehr?: Partial<WeltenHandlungsErgebnis>) => WeltenHandlungsErgebnis): Promise<WeltenHandlungsErgebnis> {
    const fremde = this.angaben.filter((m) => m.name !== this.eigene);
    const frist = (this.opt.fern.verbindenS + 4) * 1000;
    const r = await Promise.all(fremde.map((m) => this.fern.auftrag(m.name, m.ssh, { befehl: 'hallo' }, frist)));
    const saetze = fremde.map((m, i) => {
      const x = r[i];
      return x.ok ? `${m.name} erreichbar.` : x.verbindung ? `${m.name} antwortet, aber: ${x.text}` : `${m.name} nicht erreichbar: ${x.text}`;
    });
    this.geaendert();
    return antwort(true, saetze.join(' ') || 'Keine Agent-Maschine eingetragen.', { maschinen: this.maschinenNutzlast() });
  }

  /**
   * `welt:umziehen {"welt", "maschine", "trocken"}`: eine Welt dieser Maschine ueber `wb-welt umziehen`
   * (shell/agents_weltumzug.py) auf eine Agent-Maschine. Ohne `bestaetigt` prueft erst ein Trockenlauf
   * beide Seiten; nur wenn nichts dagegen spricht, kommt die Rueckfrage.
   */
  private async umziehen(welt: Welt, daten: Record<string, unknown>, bestaetigt: boolean,
    antwort: (ok: boolean, meldung: string, mehr?: Partial<WeltenHandlungsErgebnis>) => WeltenHandlungsErgebnis): Promise<WeltenHandlungsErgebnis> {
    if (welt.fern) return antwort(false, `${welt.name} liegt schon auf ${welt.maschine}; umgezogen wird von der Maschine aus, auf der die Welt liegt.`);
    const maschine = s(daten.maschine).trim() || this.maschineVorgabe();
    if (maschine === this.eigene || !this.angaben.some((m) => m.name === maschine)) {
      return antwort(false, `„${maschine}“ ist keine Agent-Maschine für einen Umzug.`);
    }
    const m = this.angabe(maschine);
    const args = [join(dirname(this.opt.daten), 'agents_weltumzug.py'), welt.ablage, maschine, '--json', `--ssh-host=${m.ssh}`,
      `--register=${this.opt.fern.register}`, `--ssh=${this.opt.fern.ssh}`, `--laufzeit=${this.opt.fern.laufzeit}`];
    const trocken = daten.trocken === true;
    if (trocken || !bestaetigt) {
      const t = await this.lauf(this.opt.python, [...args, '--trocken'], this.opt.fern.fristMs * 2);
      const plan = jsonAus<Record<string, unknown>>(t);
      if (t.code !== 0 || !plan || plan.fehler) return antwort(false, s(plan?.fehler) || kurz(t), plan ? { umzug: plan } : {});
      const beiseite = basename(s(plan.umbenannt));
      if (trocken) {
        return antwort(true, `Trocken: ${welt.name} zöge nach ${maschine}:${s(plan.nach)}; hier hieße die Ablage danach ${beiseite}. Nichts kopiert, nichts umbenannt.`, { umzug: plan });
      }
      return antwort(false, 'Rückfrage', {
        rueckfrage: `${welt.name} nach ${maschine} umziehen?`,
        warnungen: [
          `Die Ablage wird nach ${maschine}:${s(plan.nach)} kopiert und dort geprüft; dort bekommt die Welt ihren Träger.`,
          `Hier bleibt sie als ${beiseite} liegen und steht nicht mehr in der Liste der Welten.`,
        ],
        umzug: plan,
      });
    }
    this.umzug.add(welt.pfad);
    try {
      const l = await this.lauf(this.opt.python, args, this.opt.fern.umzugMs);
      const r = jsonAus<Record<string, unknown>>(l);
      if (l.code !== 0 || !r || r.fehler) return antwort(false, s(r?.fehler) || kurz(l), r ? { umzug: r } : {});
      this.gemerkt.delete(welt.pfad);
      this.waechter.get(welt.pfad)?.close();
      this.waechter.delete(welt.pfad);
      await this.finden(this.projekteZumFinden());
      const schluessel = fernSchluessel(maschine, s(r.nach));
      await this.fernFinden(m);
      const fund = this.alleFernFunde().find((f) => fundSchluessel(f) === schluessel);
      if (fund) await this.fernLesen(fund);
      this.geaendert();
      const t = (r.traeger ?? {}) as { eingerichtet?: boolean; fehler?: string };
      const traeger = t.fehler ? ` Träger dort nicht eingerichtet: ${t.fehler}` : t.eingerichtet ? ' Träger dort eingerichtet.' : '';
      return antwort(true, `${welt.name} ist nach ${maschine} umgezogen; hier liegt die alte Ablage als ${basename(s(r.umbenannt))}.${traeger}`, { pfad: schluessel, umzug: r });
    } finally {
      this.umzug.delete(welt.pfad);
    }
  }

  /**
   * Eine Handlung `welt:<handlung> <JSON>`. Die Welt muss eine gefundene sein --
   * ein beliebiger Pfad aus einem Steuerkanal wird nicht beschrieben.
   */
  async ausfuehren(befehl: string, herkunft: 'oberflaeche' | 'steuerkanal', opt: unknown = {}): Promise<WeltenHandlungsErgebnis> {
    const b = weltBefehlLesen(befehl);
    if ('fehler' in b) return { ok: false, handlung: '', id: '', meldung: b.fehler };
    const { handlung, daten } = b;
    const bestaetigt = (opt as { bestaetigt?: unknown } | null)?.bestaetigt === true;
    const echt = (opt as { echt?: unknown } | null)?.echt === true;
    const pfad = s(daten.welt);
    const antwort = (ok: boolean, meldung: string, mehr: Partial<WeltenHandlungsErgebnis> = {}): WeltenHandlungsErgebnis =>
      ({ ok, handlung: `welt:${handlung}`, id: pfad, meldung, ...mehr });
    if (!this.opt.daten || !existsSync(this.opt.daten)) return antwort(false, 'Die Datenbibliothek agents_data.py ist nicht gefunden.');
    // Die einzige Handlung ohne gefundene Welt: sie legt eine an.
    if (handlung === 'neu') return this.weltAnlegen(daten);
    if (handlung === 'vergessen') return this.vergessen(daten, bestaetigt, antwort);
    if (handlung === 'maschinen') return this.maschinenPruefen(antwort);
    if (handlung === 'gewaehlt') {
      this.gewaehlt = pfad;
      if (fernSchluesselLesen(pfad)) this.geaendert();
      return antwort(true, '');
    }
    const welt = this.welt(pfad);
    if (!welt) return antwort(false, pfad ? `Keine bekannte Welt unter ${pfad}.` : 'Die Angabe welt fehlt.');
    if (this.umzug.has(pfad)) return antwort(false, `${welt.name} zieht gerade um; bis dahin geht keine Handlung an sie.`);
    if (handlung === 'umziehen') return this.umziehen(welt, daten, bestaetigt, antwort);
    // Der Pfad der Ablage auf ihrer Maschine: bei einer lokalen Welt derselbe wie `pfad`.
    const ort = welt.ablage;
    const absender = absenderFuer(herkunft, echt);
    const agent = s(daten.agent);
    if (agent && !welt.agenten.some((a) => a.id === agent)) return antwort(false, `Kein Agent „${agent}“ in ${welt.name}.`);
    const text = s(daten.text).trim();
    const ausgefuehrt = async (args: string[], erfolg: string, geweckt: string[] = []): Promise<WeltenHandlungsErgebnis> => {
      const l = await this.datenFuer(welt, args, { wecken: WECKEN.has(handlung) });
      // Auftrag agentaktiv: das Wecken merken, bevor neu gelesen wird; der Stand unter der Nachricht nennt es.
      if (l.code === 0 && geweckt.length) this.weckStand.set(pfad, { ...this.geweckt(pfad), ...Object.fromEntries(geweckt.map((id) => [id, l.weckRoh])) });
      await this.nachHandlung(pfad);
      return l.code === 0 ? antwort(true, erfolg + l.weck) : antwort(false, kurz(l));
    };

    switch (handlung) {
      case 'senden': {
        if (!text) return antwort(false, 'Die Nachricht ist leer.');
        const an = Array.isArray(daten.an) ? daten.an.map(String) : [];
        const r = adressenAufloesen(welt, an);
        if (r.fehler) return antwort(false, r.fehler);
        const direkt = daten.direkt === true;
        if (direkt && r.ids.includes('alle')) return antwort(false, 'Ein Einzelchat braucht einen Agenten, nicht „alle“.');
        const ticket = s(daten.ticket);
        const args = ['kanal', 'senden', ort, `--absender=${absender}`, ...r.ids.map((a) => `--an=${a}`), `--text=${text}`, '--json'];
        if (direkt) args.push('--direkt');
        if (ticket) args.push(`--ticket=${ticket}`);
        const namen = r.ids.map((id) => (id === 'alle' ? 'alle' : welt.agenten.find((a) => a.id === id)?.name ?? id)).join(', ');
        return ausgefuehrt(args, direkt ? `Nachricht an ${namen} gesendet.` : `Im Kanal an ${namen} gesendet.`, direkt ? r.ids : []);
      }

      case 'antworten': {
        const frage = welt.fragen.find((f) => f.id === s(daten.frage));
        if (!frage) return antwort(false, `Keine Frage „${s(daten.frage)}“ in ${welt.name}.`);
        if (!text) return antwort(false, 'Die Antwort ist leer.');
        return ausgefuehrt(['welt', 'antwort', ort, frage.id, `--text=${text}`, `--absender=${absender}`, '--json'], 'Antwort gespeichert.');
      }

      case 'zuruecknehmen': {
        const frage = welt.fragen.find((f) => f.id === s(daten.frage));
        if (!frage) return antwort(false, `Keine Frage „${s(daten.frage)}“ in ${welt.name}.`);
        if (!bestaetigt) {
          return antwort(false, 'Rückfrage', { rueckfrage: `Frage „${frage.text}“ zurücknehmen? Sie steht danach nicht mehr offen und bekommt keine Antwort.` });
        }
        const grund = s(daten.grund).trim();
        const args = ['welt', 'ruecknahme', ort, frage.id, `--absender=${absender}`, '--json'];
        if (grund) args.push(`--grund=${grund}`);
        return ausgefuehrt(args, 'Frage zurückgenommen.');
      }

      case 'pausieren':
      case 'fortsetzen':
      case 'stoppen': {
        const wort = handlung === 'pausieren' ? 'pause' : handlung === 'fortsetzen' ? 'start' : 'stop';
        const ziel = agent ? welt.agenten.find((a) => a.id === agent)?.name ?? agent : welt.name;
        if (handlung === 'stoppen' && !bestaetigt) {
          const laufend = welt.tickets.filter((t) => (t.stand === 'läuft' || t.stand === 'zur Abnahme') && (!agent || t.bearbeiter === agent));
          return antwort(false, 'Rückfrage', {
            rueckfrage: agent ? `${ziel} sofort stoppen? Neue Starts sind gesperrt, bis jemand ihn fortsetzt.` : `Die Welt ${ziel} sofort stoppen? Kein Agent dieser Welt startet, bis jemand sie fortsetzt.`,
            warnungen: laufend.map((t) => `„${t.titel}“ steht auf ${t.stand} und wird als unterbrochen markiert.`),
          });
        }
        const grund = s(daten.grund).trim();
        const args = agent ? ['agent', wort, ort, agent] : ['welt', wort, ort];
        args.push(`--absender=${absender}`, '--json');
        if (grund) args.push(`--grund=${grund}`);
        const erfolg = handlung === 'pausieren' ? `${ziel} pausiert.` : handlung === 'fortsetzen' ? `${ziel} läuft wieder.` : `${ziel} gestoppt.`;
        return ausgefuehrt(args, erfolg);
      }

      case 'ticket': {
        const titel = s(daten.titel).trim();
        const ziel = s(daten.ziel).trim();
        const fertig = s(daten.fertig).trim();
        if (!titel || !ziel || !fertig) return antwort(false, 'Titel, Ziel und „fertig heißt“ sind Pflicht.');
        const an = Array.isArray(daten.an) && daten.an.length ? daten.an.map(String) : welt.hauptagent ? [welt.hauptagent] : [];
        const team = an.find((a) => a.startsWith('team:'))?.slice(5) ?? '';
        const einzeln = an.filter((a) => !a.startsWith('team:'));
        if (team && !welt.teams.some((t) => t.name === team)) return antwort(false, `Kein Team „${team}“ in ${welt.name}.`);
        const fremd = einzeln.find((a) => !welt.agenten.some((x) => x.id === a));
        if (fremd) return antwort(false, `Kein Agent „${fremd}“ in ${welt.name}.`);
        if (!team && !einzeln.length) return antwort(false, 'Das Ticket braucht einen Adressaten.');
        const args = ['ticket', 'neu', ort, `--titel=${titel}`, `--ziel=${ziel}`, `--fertig=${fertig}`, ...einzeln.map((a) => `--an=${a}`), `--absender=${absender}`, '--json'];
        if (team) args.push(`--team=${team}`);
        return ausgefuehrt(args, `Ticket „${titel}“ angelegt.`);
      }

      case 'zurueckgeben': {
        const ticket = welt.tickets.find((x) => x.id === s(daten.ticket));
        if (!ticket) return antwort(false, `Kein Ticket „${s(daten.ticket)}“ in ${welt.name}.`);
        if (ticket.stand !== 'abgenommen') return antwort(false, `„${ticket.titel}“ steht auf ${ticket.stand}; zurückgeben lässt sich nur ein abgenommenes Ticket.`);
        const bemerkung = s(daten.bemerkung).trim();
        if (!bemerkung) return antwort(false, 'Die Rückgabe braucht eine Bemerkung, was fehlt.');
        const an = ticket.bearbeiter ? welt.agenten.find((a) => a.id === ticket.bearbeiter)?.name ?? ticket.bearbeiter : 'die Adressaten';
        return ausgefuehrt(['ticket', 'zurueckgeben', ort, ticket.id, `--absender=${absender}`, `--bemerkung=${bemerkung}`, '--json'],
          `„${ticket.titel}“ geht mit deiner Bemerkung an ${an} zurück.`);
      }

      case 'profil': {
        if (!agent) return antwort(false, 'Die Angabe agent fehlt.');
        const felder: [string, string][] = [['modell', '--modell'], ['denkstufe', '--denkweise'], ['fallback', '--fallback'],
          ['fallback_denkstufe', '--fallback-denkweise'], ['maschine', '--maschine'], ['spezialgebiet', '--beschreibung']];
        const args = ['agent', 'profil', ort, agent];
        for (const [feld, schalter] of felder) {
          if (typeof daten[feld] === 'string') args.push(`${schalter}=${String(daten[feld]).trim()}`);
        }
        if (args.length === 4) return antwort(false, 'Keine Profiländerung angegeben.');
        args.push(`--absender=${absender}`, '--json');
        const name = welt.agenten.find((a) => a.id === agent)?.name ?? agent;
        const modell = typeof daten.modell === 'string' || typeof daten.denkstufe === 'string' || typeof daten.fallback === 'string';
        return ausgefuehrt(args, modell ? `Profil von ${name} gesichert; das Modell gilt ab dem nächsten Start.` : `Profil von ${name} gesichert.`);
      }

      case 'rechte': {
        if (!agent) return antwort(false, 'Die Angabe agent fehlt.');
        const name = welt.agenten.find((a) => a.id === agent)?.name ?? agent;
        const form = this.rechteFormFuer(welt);
        if (!form) {
          return antwort(false, `Rechte ändern ist ${welt.fern ? `auf ${welt.maschine}` : 'hier'} noch nicht ausgerollt: die Datenbibliothek kennt „wb-agent rechte“ noch nicht. Die Rechte von ${name} stehen im Profil nur zum Lesen.`);
        }
        const listeAus = (k: string): string[] | undefined => (Array.isArray(daten[k]) ? [...new Set((daten[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean))] : undefined);
        const wunsch: RechteWunsch = { werkzeuge: listeAus('werkzeuge'), bash: listeAus('bash'), skills: listeAus('skills') };
        if (!wunsch.werkzeuge && !wunsch.bash && !wunsch.skills) return antwort(false, 'Keine Rechteänderung angegeben.');
        if (wunsch.werkzeuge?.some((w) => WEB_WERKZEUGE.includes(w)) && !welt.web_zugang) return antwort(false, webZugangSatz(ort));
        const l = await this.datenFuer(welt, rechteArgs(ort, agent, wunsch, form, absender));
        await this.nachHandlung(pfad);
        if (l.code !== 0) return antwort(false, kurz(l));
        const jetzt = this.welt(pfad)?.agenten.find((a) => a.id === agent);
        const abweichung = jetzt ? rechteAbweichung(wunsch, jetzt) : '';
        if (abweichung) return antwort(false, `Die Rechte von ${name} sind geschrieben, aber das Profil trägt sie anders: ${abweichung}.`);
        return antwort(true, `Rechte von ${name} gesichert; sie gelten ab dem nächsten Zug.`);
      }

      case 'gedaechtnis': {
        if (!agent) return antwort(false, 'Die Angabe agent fehlt.');
        if (typeof daten.text !== 'string') return antwort(false, 'Der Text des Gedächtnisses fehlt.');
        const erwartet = s(daten.erwartet);
        const args = ['agent', 'gedaechtnis', ort, agent, `--text=${daten.text}`, `--absender=${absender}`, '--json'];
        if (erwartet) args.push(`--erwartet=${erwartet}`);
        const name = welt.agenten.find((a) => a.id === agent)?.name ?? agent;
        return ausgefuehrt(args, `Gedächtnis von ${name} gesichert.`);
      }

      case 'gelesen': {
        const gespraech = s(daten.gespraech);
        if (!gespraechGueltig(gespraech)) return antwort(false, `Gespräch „${gespraech}“ ist ungültig.`);
        const zeit = s(daten.zeit);
        const id = s(daten.id);
        if (!zeit || !id) return antwort(false, 'Zeit und Kennung der zuletzt gesehenen Nachricht fehlen.');
        return ausgefuehrt(['welt', 'gelesen', ort, `--gespraech=${gespraech}`, `--zeit=${zeit}`, `--nachricht=${id}`, `--absender=${absender}`, '--json'],
          'Lesestand gesichert.');
      }

      case 'vorschlag': {
        const beschreibung = s(daten.beschreibung).trim();
        if (!beschreibung) return antwort(false, 'Die Beschreibung fehlt: Was soll der neue Agent tun?');
        const m = await this.modellAufloesen(s(daten.modell) || ENTWURF_MODELLE[0], 'Vorschläge schreibt');
        if ('fehler' in m) return antwort(false, m.fehler);
        const roh = daten.vorgaben && typeof daten.vorgaben === 'object' && !Array.isArray(daten.vorgaben) ? daten.vorgaben as Record<string, unknown> : {};
        const vorgaben = Object.fromEntries(Object.entries(roh).filter(([k]) => (ENTWURF_FELDER as readonly string[]).includes(k)));
        await this.katalog();
        const prompt = entwurfPrompt(beschreibung, {
          name: welt.name, hauptagent: welt.hauptagent, teams: welt.teams.map((t) => ({ name: t.name, leiter: t.leiter })), agenten: welt.agenten.map((a) => a.id),
          maschine: welt.maschine_vorgabe || welt.maschine,
        }, vorgaben, promptModelle(welt.modelle, this.modelle));
        const trocken = daten.trocken === true;
        const r = await vorschlagLaufen(m, prompt, this.opt.entwurf, trocken);
        const hinweis = m.hinweis ? ` ${m.hinweis}` : '';
        if (trocken) {
          return antwort(true, `Trockenlauf: ${m.kennung} über ${m.harness} mit Denkstufe ${m.stufe}, ohne Werkzeuge in einem leeren Ordner; nichts gestartet.${hinweis}`, { aufruf: r.aufruf });
        }
        if (r.fehler) return antwort(false, r.fehler, { aufruf: r.aufruf, dauer_ms: r.dauer });
        const e = entwurfAusText(r.text, vorgaben, welt.agenten.map((a) => a.id));
        if ('fehler' in e) return antwort(false, e.fehler, { aufruf: r.aufruf, dauer_ms: r.dauer });
        const pruef = await this.datenFuer(welt, ['agent', 'entwurf', ort, `--entwurf=${JSON.stringify(e.entwurf)}`, '--json']);
        const vorschau = jsonAus<{ draft?: Record<string, unknown>; instructions?: string }>(pruef);
        const ok = pruef.code === 0 && !!vorschau?.draft;
        return antwort(true, `Vorschlag von ${m.kennung} in ${Math.max(1, Math.round(r.dauer / 1000))} s. Bitte durchsehen; angelegt wird erst mit „Anlegen“.${hinweis}`, {
          entwurf: ok ? vorschau!.draft : e.entwurf, anweisungen: ok ? s(vorschau!.instructions) : s(e.entwurf.instructions),
          pruefung: ok ? '' : kurz(pruef), aufruf: r.aufruf, kosten: r.kosten, dauer_ms: r.dauer,
        });
      }

      case 'gespraech': {
        if (daten.verwerfen === true) {
          this.gespraeche.verwerfen(pfad);
          return antwort(true, 'Gespräch verworfen.', { verlauf: [] });
        }
        const eingabe = s(daten.text).trim();
        if (!eingabe) return antwort(false, 'Die Nachricht ist leer.');
        if (eingabe.length > GESPRAECH_GRENZEN.zeichen) return antwort(false, `Die Nachricht ist länger als ${GESPRAECH_GRENZEN.zeichen} Zeichen.`);
        const m = await this.modellAufloesen(s(daten.modell) || ENTWURF_MODELLE[0], 'Das Gespräch führt');
        if ('fehler' in m) return antwort(false, m.fehler);
        const basis = entwurfsFelder(daten.entwurf);
        const vorgaben = entwurfsFelder(daten.vorgaben);
        const trocken = daten.trocken === true;
        if (!trocken && !this.gespraeche.beginnen(pfad)) return antwort(false, 'In dieser Welt läuft schon ein Zug des Gesprächs.');
        try {
          if (daten.neu === true) this.gespraeche.verwerfen(pfad);
          const verlauf = this.gespraeche.verlauf(pfad);
          await this.katalog();
          const belegt = welt.agenten.map((a) => a.id);
          const prompt = gespraechPrompt(eingabe, {
            name: welt.name, hauptagent: welt.hauptagent, teams: welt.teams.map((t) => ({ name: t.name, leiter: t.leiter })), agenten: belegt,
            maschine: welt.maschine_vorgabe || welt.maschine,
          }, basis, vorgaben, promptModelle(welt.modelle, this.modelle), verlauf);
          const r = await vorschlagLaufen(m, prompt, this.opt.entwurf, trocken, undefined, GESPRAECH_SYSTEM);
          const hinweis = m.hinweis ? ` ${m.hinweis}` : '';
          if (trocken) {
            return antwort(true, `Trockenlauf: ${m.kennung} über ${m.harness} mit Denkstufe ${m.stufe}, ohne Werkzeuge in einem leeren Ordner; nichts gestartet, der Verlauf bleibt bei ${verlauf.length} Nachrichten.${hinweis}`,
              { aufruf: r.aufruf, verlauf, entwurf: basis, felder: [] });
          }
          if (r.fehler) return antwort(false, r.fehler, { aufruf: r.aufruf, dauer_ms: r.dauer, verlauf });
          const t = antwortTrennen(r.text);
          if (!t.prosa && !t.block) return antwort(false, 'Das Modell lieferte eine leere Antwort.', { aufruf: r.aufruf, dauer_ms: r.dauer, verlauf });
          const b = t.block ? blockLesen(t.block) : { teil: {}, fragen: [], fertig: false };
          const g = gespraechMischen(basis, b.teil, vorgaben, belegt);
          const prosa = t.prosa || 'Entwurf ergänzt.';
          const id = s(g.entwurf.id).trim();
          let pruefung = '';
          if (!id) pruefung = 'Der neue Agent braucht noch einen Namen.';
          else if (belegt.includes(id)) pruefung = `„${id}“ gibt es in ${welt.name} schon.`;
          else {
            const l = await this.datenFuer(welt, ['agent', 'entwurf', ort, `--entwurf=${JSON.stringify(g.entwurf)}`, '--json']);
            if (l.code !== 0 || !jsonAus<{ draft?: unknown }>(l)?.draft) pruefung = kurz(l);
          }
          const zeit = new Date().toISOString();
          this.gespraeche.anhaengen(pfad, { rolle: 'mensch', text: eingabe, felder: [], zeit }, { rolle: 'modell', text: prosa, felder: g.felder, zeit, pruefung });
          const sekunden = Math.max(1, Math.round(r.dauer / 1000));
          return antwort(true, t.block ? `Antwort von ${m.kennung} in ${sekunden} s.${hinweis}` : `Antwort von ${m.kennung} in ${sekunden} s, ohne Entwurfsblock; der Entwurf bleibt, wie er war.${hinweis}`, {
            antwort: prosa, entwurf: g.entwurf, felder: g.felder, fragen: b.fragen, fertig: b.fertig, verlauf: this.gespraeche.verlauf(pfad),
            pruefung, aufruf: r.aufruf, kosten: r.kosten, dauer_ms: r.dauer,
          });
        } finally {
          if (!trocken) this.gespraeche.beenden(pfad);
        }
      }

      case 'entwurf':
      case 'anlegen': {
        const entwurf = daten.entwurf && typeof daten.entwurf === 'object' && !Array.isArray(daten.entwurf) ? daten.entwurf as Record<string, unknown> : null;
        if (!entwurf) return antwort(false, 'Der Entwurf fehlt.');
        const id = s(entwurf.id).trim();
        if (!id) return antwort(false, 'Der neue Agent braucht einen Namen.');
        if (welt.agenten.some((a) => a.id === id)) return antwort(false, `„${id}“ gibt es in ${welt.name} schon.`);
        if (handlung === 'entwurf') {
          const l = await this.datenFuer(welt, ['agent', 'entwurf', ort, `--entwurf=${JSON.stringify(entwurf)}`, '--json']);
          const v = jsonAus<{ draft?: Record<string, unknown>; instructions?: string }>(l);
          if (l.code !== 0 || !v?.draft) return antwort(false, kurz(l), { pruefung: kurz(l) });
          return antwort(true, 'Entwurf geprüft.', { entwurf: v.draft, anweisungen: s(v.instructions) });
        }
        const angelegt = await ausgefuehrt(['agent', 'anlegen', ort, `--entwurf=${JSON.stringify(entwurf)}`, `--absender=${absender}`, '--json'],
          `„${id}“ ist in ${welt.name} angelegt. Ein Prozess startet erst mit dem ersten Ticket oder der ersten Nachricht.`);
        // Der Entwurf ist jetzt ein Agent: ein Gespraech darueber gehoert zu keinem offenen Entwurf mehr.
        if (angelegt.ok) this.gespraeche.verwerfen(pfad);
        return angelegt;
      }

      case 'skill_abnehmen':
      case 'skill_ablehnen': {
        const ticket = welt.tickets.find((x) => x.id === s(daten.ticket));
        if (!ticket) return antwort(false, `Kein Ticket „${s(daten.ticket)}“ in ${welt.name}.`);
        if (ticket.art !== 'skill-vorschlag') return antwort(false, `„${ticket.titel}“ ist kein Skill-Vorschlag.`);
        const skillCli = join(dirname(this.opt.daten), 'agents_skills.py');
        if (!welt.fern && !existsSync(skillCli)) return antwort(false, `agents_skills.py fehlt neben ${this.opt.daten}.`);
        const name = ticket.skill_vorschlag?.skill ?? ticket.id;
        const args = [handlung === 'skill_abnehmen' ? 'abnehmen' : 'ablehnen', ort, ticket.id, `--absender=${absender}`, '--json'];
        if (handlung === 'skill_abnehmen') {
          const bemerkung = s(daten.bemerkung).trim();
          if (bemerkung) args.push(`--bemerkung=${bemerkung}`);
        } else {
          const grund = s(daten.grund).trim();
          if (!grund) return antwort(false, 'Die Ablehnung braucht einen Grund.');
          args.push(`--grund=${grund}`);
        }
        const l = await this.datenFuer(welt, args, { skript: 'agents_skills.py' });
        await this.nachHandlung(pfad);
        if (l.code !== 0) return antwort(false, kurz(l).replace(/^wb-skill: FEHLER - /, ''));
        const ziel = ticket.skill_vorschlag?.ziel === 'bibliothek' ? 'die Bibliothek' : 'die Welt';
        return antwort(true, handlung === 'skill_abnehmen' ? `Skill „${name}“ ist in ${ziel} übernommen.` : `Skill-Vorschlag „${name}“ abgelehnt.`);
      }

      case 'quittieren': {
        const zustellung = s(daten.zustellung);
        if (!zustellung) return antwort(false, 'Die Angabe zustellung fehlt.');
        return ausgefuehrt(['kanal', 'quittieren', ort, `--agent=${WELT_MENSCH}`, `--zustellung=${zustellung}`, `--absender=${absender}`, '--json'],
          'Zur Kenntnis genommen.');
      }
    }
    return antwort(false, `Handlung ${handlung} ist hier nicht verdrahtet.`);
  }
}
