/**
 * ATTRAPPEN-DATEN FUER DIE SICHTBARE PWA (Paket 9).
 *
 * Alle Zeiten liegen relativ zu `jetzt`, damit die Ansicht immer „frisch“
 * wirkt. Die Formen sind die des Vertrags (`mobile-shared/vertrag.ts`); der
 * Agents-Teil folgt der Weltenform des Kerns (`main/welten.ts`), aus der
 * `components/agents-daten.ts` liest. Modellkennungen stammen aus
 * `shell/models.default.json`.
 */
import type {
  Approval,
  AgentsData,
  ChatMessage,
  Notification,
  Prompt,
  SessionSummary,
} from '../../mobile-shared/vertrag';
import type { MaschinenStand, StartOptionen } from '../components/quelle';
import { teamsAusAgenten, type AgentKurz } from '../components/agents-daten';

export type Szenario = 'standard' | 'alle' | 'offline' | 'ungekoppelt' | 'leer';

export const SZENARIEN: readonly Szenario[] = ['standard', 'alle', 'offline', 'ungekoppelt', 'leer'];

export const MAC_ORIGIN = 'https://mac.tailnet.example.ts.net';
export const PEER_ORIGIN = 'https://peer.tailnet.example.ts.net';

export interface AttrappenWelt {
  maschinen: MaschinenStand[];
  sitzungen: SessionSummary[];
  chats: Map<string, ChatMessage[]>;
  prompts: Map<string, Prompt>;
  freigaben: Approval[];
  meldungen: Notification[];
  agents: AgentsData;
  start: StartOptionen;
}

const MIN = 60_000;
const STD = 60 * MIN;

function werkzeugAus(text: string): ChatMessage['tool'] {
  const [kopf, ...ausgabe] = text.split('\n');
  const treffer = kopf.match(/^([A-Za-z][\w.-]*)\((.*)\)$/);
  return {
    name: treffer?.[1] ?? 'Werkzeug',
    arguments_preview: treffer?.[2] ?? kopf,
    output_preview: ausgabe.join('\n').slice(0, 8_000),
  };
}

function nachrichten(jetzt: number, id: string, zeilen: [ChatMessage['role'], string, number][]): ChatMessage[] {
  return zeilen.map(([role, text, vorMin], i) => ({
    id: `${id}-m${i + 1}`, role, text, created_at: jetzt - vorMin * MIN,
    ...(role === 'tool' ? { tool: werkzeugAus(text) } : {}),
  }));
}

function werkbankChat(jetzt: number): ChatMessage[] {
  return nachrichten(jetzt, 'werkbank', [
    ['human', 'Wie weit sind die Mobilpakete? Ich will heute Abend die Oberfläche auf dem iPhone sehen.', 38],
    ['agent', 'Ich sehe mir den Stand der drei laufenden Worker an.', 38],
    ['tool', 'Bash(wb-status --kurz)\nmobil-auth   fertig     vor 21 Min.   Commit 4c1e9a0\nmobil-http   blockiert  Befehl angehalten\nmobil-ui     läuft      seit 34 Min.', 37],
    ['tool', 'Read(MOBILE-APP-SPEC.md)\n293 Zeilen gelesen', 37],
    ['agent', '**Stand um diese Uhrzeit:**\n\n- `mobil-auth` (Paket 2) ist fertig. Die Negativmatrix hat 38 Fälle, alle grün. Ich prüfe den Commit, bevor ich ihn übernehme.\n- `mobil-http` (Paket 4) hängt an einem angehaltenen Befehl. Er will das Bauverzeichnis löschen; das liegt in seinem eigenen Worktree.\n- `mobil-ui` (Paket 9) baut die sichtbare Oberfläche mit Attrappen-Daten.\n\nFür heute Abend reicht Paket 9 allein: die Oberfläche läuft ohne Server.', 36],
    ['human', 'Gut. Lass mobil-http den Befehl ausführen, wenn er wirklich nur im Worktree löscht.', 22],
    ['tool', 'Bash(wb-freigabe zeigen g-7f3a)\nBefehl: rm -rf app/dist/mobile\nVerzeichnis: ~/.pi-workers/worktrees/mobil-http\nMuster: rm -rf <Pfad>', 21],
    ['agent', 'Der Pfad liegt im Worktree von `mobil-http`, nicht im Hauptbaum. Annehmen darf ich den Befehl nicht selbst; die Freigabe liegt unten bei Dir.\n\nAußerdem hat `mobil-http` einen Teil-Worker beantragt, der die SSE-Wiederverbindung testet. Der Antrag steht ebenfalls unten.', 20],
    ['system', 'Worker mobil-auth ist fertig.', 19],
    ['tool', 'Bash(git -C ~/.pi-workers/worktrees/mobil-auth log --oneline -3)\n4c1e9a0 feat: verify mobile request envelopes\n9b27d11 test: add negative matrix for device auth\n6a7d3eb feat: add mobile API contract', 18],
    ['agent', 'Den Commit von `mobil-auth` prüfe ich jetzt gegen die Negativmatrix aus Abschnitt 8.2. Ich melde mich, sobald das Ergebnis steht.', 17],
  ]);
}

function vaultChat(jetzt: number): ChatMessage[] {
  return nachrichten(jetzt, 'vault', [
    ['human', 'Räum bitte die Notizen zur Stellensuche zusammen. Doppelte Bewerbungsnotizen zusammenführen.', 14],
    ['agent', 'Ich suche zuerst nach den betroffenen Notizen.', 14],
    ['tool', 'Bash(brain search "Bewerbung Stellensuche" -k 5)\n40-people/grundwerk-digital.md        0.82\n20-projekte/stellensuche/welle-3.md    0.79\n20-projekte/stellensuche/welle-2.md    0.74', 13],
    ['agent', 'Drei Treffer. `welle-2.md` und `welle-3.md` überschneiden sich bei fünf Firmen. Bevor ich zusammenführe, hole ich den aktuellen Stand des Vaults.', 12],
    ['tool', 'Bash(git -C ~/Knowledge pull --rebase)\nwartet auf Bestätigung', 11],
  ]);
}

function tradingChat(jetzt: number): ChatMessage[] {
  return nachrichten(jetzt, 'trading', [
    ['human', 'Starte den Backtest für die Emergency-Brake-Variante B über 2023 bis heute.', 52],
    ['tool', 'Shell(python -m backtest --variante brake-b --von 2023-01-01)\nLade 612 Handelstage …\nFertig in 4 Min. 12 s', 50],
    ['agent', 'Ergebnis Variante B gegen die Baseline:\n\n| Kennzahl | Baseline | Variante B |\n|---|---|---|\n| Rendite p. a. | 7,9 % | 8,4 % |\n| Max. Drawdown | −18,2 % | −11,6 % |\n| Trades | 214 | 188 |\n\nDer Drawdown sinkt deutlich. Die höhere Rendite hält out-of-sample aber nur knapp; ich prüfe noch die Robustheits-Gates.', 45],
    ['tool', 'Shell(python -m gates --lauf brake-b)\n5 von 6 Gates bestanden\nGate „Walk-forward 2025“: nicht bestanden (Sharpe 0,41 < 0,5)', 6],
    ['agent', 'Fünf von sechs Gates bestehen. Walk-forward 2025 fällt knapp durch. Ich rechne die Variante mit halbierter Positionsgröße nach.', 5],
  ]);
}

function anlassChat(jetzt: number): ChatMessage[] {
  return nachrichten(jetzt, 'anlass', [
    ['human', 'Fasse die Antworten der letzten Welle zusammen.', 26 * 60],
    ['agent', 'Zwei Rückmeldungen, beide mit Terminvorschlag. Die Zusammenfassung liegt in `runs/2026-09-17/report.md`.', 26 * 60 - 3],
    ['system', 'Sitzung beendet.', 25 * 60],
  ]);
}

function omarchyChat(jetzt: number): ChatMessage[] {
  return nachrichten(jetzt, 'omarchy', [
    ['human', 'Stell die Hyprland-Tastenbelegung für den zweiten Monitor um.', 70],
    ['agent', 'Erledigt. Die Belegung steht in `~/.config/hypr/bindings.conf`, Zeilen 40 bis 52.', 66],
  ]);
}

export function erzeugen(jetzt: number, szenario: Szenario): AttrappenWelt {
  const peerDirekt = szenario === 'alle';
  const macDa = szenario !== 'offline';
  const maschinen: MaschinenStand[] = [
    {
      machine: 'mac', name: 'Mac', origin: MAC_ORIGIN, erreichbar: macDa,
      seit: macDa ? null : jetzt - 3 * MIN, zuletzt: macDa ? jetzt : jetzt - 3 * MIN,
      server_build: '2026.09.18-6a7d3eb', api_version: '1',
    },
    {
      machine: 'peer', name: 'peer', origin: PEER_ORIGIN, erreichbar: peerDirekt,
      seit: peerDirekt ? null : jetzt - 47 * MIN, zuletzt: peerDirekt ? jetzt : jetzt - 47 * MIN,
      server_build: peerDirekt ? '2026.09.18-6a7d3eb' : null, api_version: peerDirekt ? '1' : null,
    },
  ];

  const peerQuelle = peerDirekt ? 'authoritative' : 'mirror';
  const peerAlter = peerDirekt ? 1_000 : 47 * MIN;
  const roheSitzungen: Omit<SessionSummary, 'worker_count' | 'running_worker_count'>[] = szenario === 'leer' ? [] : [
    {
      id: 'mac:werkbank', source: 'authoritative', name: 'werkbank', harness: 'claude', model: 'claude-opus-5',
      state: 'attention', updated_at: jetzt - 17 * MIN, open_approvals: 2, data_age_ms: 1_200,
      workers: [
        { id: 'mac:werkbank/mobil-ui', name: 'mobil-ui', state: 'running', updated_at: jetzt - 1 * MIN },
        { id: 'mac:werkbank/mobil-http', name: 'mobil-http', state: 'blocked', updated_at: jetzt - 21 * MIN },
        { id: 'mac:werkbank/mobil-auth', name: 'mobil-auth', state: 'done', updated_at: jetzt - 19 * MIN },
      ],
    },
    {
      id: 'mac:knowledge-vault', source: 'authoritative', name: 'knowledge-vault', harness: 'claude', model: 'claude-sonnet-5',
      state: 'attention', updated_at: jetzt - 11 * MIN, open_approvals: 0, data_age_ms: 1_200, workers: [],
    },
    {
      id: 'mac:demo', source: 'authoritative', name: 'demo', harness: 'codex', model: 'codex-gpt-5-6-sol',
      state: 'running', updated_at: jetzt - 5 * MIN, open_approvals: 0, data_age_ms: 1_200,
      workers: [
        { id: 'mac:demo/gates', name: 'gates-halbiert', state: 'stalled', updated_at: jetzt - 13 * MIN },
      ],
    },
    {
      id: 'mac:anlass', source: 'authoritative', name: 'anlass', harness: 'pi', model: 'ornith-35b',
      state: 'stopped', updated_at: jetzt - 25 * STD, open_approvals: 0, data_age_ms: 1_200, workers: [],
    },
    {
      id: 'peer:backtest-nacht', source: peerQuelle, name: 'backtest-nacht', harness: 'opencode', model: 'opencode-gpt-5',
      state: peerDirekt ? 'running' : 'unreachable', updated_at: jetzt - 49 * MIN, open_approvals: 0, data_age_ms: peerAlter,
      workers: [
        { id: 'peer:backtest-nacht/lauf-2024', name: 'lauf-2024', state: peerDirekt ? 'running' : 'unknown', updated_at: jetzt - 49 * MIN },
        { id: 'peer:backtest-nacht/lauf-2025', name: 'lauf-2025', state: peerDirekt ? 'running' : 'unknown', updated_at: jetzt - 49 * MIN },
      ],
    },
    {
      id: 'peer:omarchy', source: peerQuelle, name: 'omarchy', harness: 'claude', model: 'claude-sonnet-5',
      state: peerDirekt ? 'running' : 'unreachable', updated_at: jetzt - 66 * MIN, open_approvals: 0, data_age_ms: peerAlter, workers: [],
    },
  ];
  // Vertrag 1.2: der Server liefert Worker nur als Zahl; die Attrappe zaehlt ihre Beispiele.
  const sitzungen: SessionSummary[] = roheSitzungen.map((s) => ({
    ...s, worker_count: s.workers.length, running_worker_count: s.workers.filter((w) => w.state === 'running').length,
    // Vertrag 1.7: jede autoritative Origin nimmt den Wartewunsch fuer ihre Sitzungen an.
    ...(s.source === 'authoritative' ? { notify_until: null } : {}),
  }));

  const chats = new Map<string, ChatMessage[]>([
    ['mac:werkbank', werkbankChat(jetzt)],
    ['mac:knowledge-vault', vaultChat(jetzt)],
    ['mac:demo', tradingChat(jetzt)],
    ['mac:anlass', anlassChat(jetzt)],
    ['peer:omarchy', omarchyChat(jetzt)],
    ['peer:backtest-nacht', nachrichten(jetzt, 'backtest', [
      ['human', 'Rechne die Läufe 2024 und 2025 über Nacht.', 55],
      ['agent', 'Beide Läufe gestartet, je ein Worker. Ergebnisse gegen 6 Uhr.', 49],
    ])],
  ]);

  const prompts = new Map<string, Prompt>([
    ['mac:knowledge-vault', {
      fingerprint: 'claude-2.4.1:7c1d0e55',
      harness: 'claude',
      harness_version: '2.4.1',
      text: 'Bash command\n\n  git -C ~/Knowledge pull --rebase\n\nDo you want to proceed?',
      selection: 'single',
      options: [
        { id: 'yes', label: 'Yes', selected: true },
        { id: 'yes-always', label: "Yes, and don't ask again for git -C commands in ~/Knowledge", selected: false },
        { id: 'no', label: 'No, and tell Claude what to do differently', selected: false },
      ],
    }],
  ]);

  const freigaben: Approval[] = szenario === 'leer' ? [] : [
    {
      id: 'g-7f3a', kind: 'guard', source: 'authoritative', session_id: 'mac:werkbank',
      summary: 'mobil-http: rm -rf app/dist/mobile', created_at: jetzt - 21 * MIN,
    },
    {
      id: 'r-2b91', kind: 'request', source: 'authoritative', session_id: 'mac:werkbank',
      summary: 'mobil-http beantragt einen Teil-Worker „sse-reconnect“ (Claude Sonnet 5, Effort medium) für die Wiederverbindungstests.',
      created_at: jetzt - 20 * MIN,
    },
  ];

  const meldungen: Notification[] = szenario === 'leer' ? [] : [
    { id: 'mac:e7:1042', type: 'worker.stalled', source: 'authoritative', machine: 'mac', target_id: 'mac:demo', created_at: jetzt - 4 * MIN, text: 'Ein Worker in demo rührt sich seit 10 Minuten nicht.' },
    { id: 'mac:e7:1039', type: 'command.blocked', source: 'authoritative', machine: 'mac', target_id: 'mac:werkbank', created_at: jetzt - 20 * MIN, text: 'Ein Worker-Antrag wartet auf Deine Entscheidung.' },
    { id: 'mac:e7:1038', type: 'worker.done', source: 'authoritative', machine: 'mac', target_id: 'mac:werkbank', created_at: jetzt - 19 * MIN, text: 'Worker mobil-auth ist fertig.' },
    { id: 'mac:e7:1036', type: 'command.blocked', source: 'authoritative', machine: 'mac', target_id: 'mac:werkbank', created_at: jetzt - 21 * MIN, text: 'Ein Befehl wurde angehalten und wartet auf Freigabe.' },
    { id: 'peer:e3:311', type: 'session.lost', source: 'mirror', machine: 'peer', target_id: 'peer:backtest-nacht', created_at: jetzt - 47 * MIN, text: 'peer antwortet nicht mehr. Letzter Stand ist gespiegelt.' },
    { id: 'mac:e7:1001', type: 'worker.done', source: 'authoritative', machine: 'mac', target_id: 'mac:demo', created_at: jetzt - 20 * STD, text: 'Worker gates-baseline ist fertig.' },
    { id: 'peer:e3:290', type: 'worker.done', source: 'authoritative', machine: 'peer', target_id: 'peer:omarchy', created_at: jetzt - 22 * STD, text: 'Worker hypr-bindings ist fertig.' },
  ];

  const iso = (vorMin: number) => new Date(jetzt - vorMin * MIN).toISOString();
  const agents = {
    mensch_absender: false,
    welten: {
      welten: [
        {
          id: 'werkbank', name: 'Werkbank', maschine: 'mac', fern: false,
          verbindung: { ok: true, seit: null, text: '' },
          hauptagent: 'kern',
          // Die Welt hat eine Definition of Done; der Kern nimmt ohne ihre
          // Bestaetigung kein Ticket ab (`_world_dod` in agents_data.py).
          dod: ['Tests grün', 'Belege im Ergebnis', 'Kein ungeprüfter Rest'],
          zaehler: { brauchen_dich: 2, laufen: 2, tickets_offen: 5 },
          agenten: [
            {
              id: 'kern', name: 'Kern', stufe: 'hauptagent', team: null, spezialgebiet: 'Planung und Verteilung',
              figur: { art: 'kern', rolle: 'hauptagent', farbe: '' }, modell: 'claude-opus-5', maschine: 'mac',
              zustand: 'braucht_dich', zustand_text: 'Hat eine Frage an Dich', figur_zustand: 'braucht_entscheidung', ticket: 'T-41', postfach_offen: 1,
              einzelchat: [
                { art: 'nachricht', id: 'k1', zeit: iso(30), frage: null, nachricht: { id: 'k1', von: 'mensch', text: 'Plane die Tickets für die Mobil-Oberfläche.', zeit: iso(30), von_mensch: true } },
                { art: 'nachricht', id: 'k2', zeit: iso(28), frage: null, nachricht: { id: 'k2', von: 'kern', text: 'Ich habe vier Tickets angelegt und T-41 an Ada gegeben. Für T-44 brauche ich Deine Entscheidung zur Tab-Leiste auf dem iPad.', zeit: iso(28), von_mensch: false } },
              ],
            },
            {
              id: 'ada', name: 'Ada', stufe: 'mitglied', team: 'entwicklung', spezialgebiet: 'TypeScript, Oberflächen',
              figur: { art: 'roboter', rolle: 'senior-dev', farbe: '' }, modell: 'claude-sonnet-5', maschine: 'mac',
              zustand: 'arbeitet', zustand_text: 'Arbeitet an T-41', figur_zustand: 'arbeitet', ticket: 'T-41', postfach_offen: 0, einzelchat: [],
            },
            {
              id: 'tjark', name: 'Tjark', stufe: 'mitglied', team: 'sicherheit', spezialgebiet: 'Sicherheitsprüfung',
              figur: { art: 'roboter', rolle: 'sicherheitspruefer', farbe: '' }, modell: 'codex-gpt-5-6-sol', maschine: 'mac',
              zustand: 'hat_ergebnis', zustand_text: 'Ergebnis zu T-39 liegt vor', figur_zustand: 'ergebnis_ungelesen', ticket: 'T-39', postfach_offen: 1, einzelchat: [],
            },
            {
              id: 'mira', name: 'Mira', stufe: 'teamleiter', team: 'gestaltung', spezialgebiet: 'iOS-Bedienung',
              figur: { art: 'tier', rolle: 'gestaltungs-leiter', farbe: '' }, modell: 'claude-opus-5', maschine: 'mac',
              zustand: 'wartet', zustand_text: 'Wartet auf T-41', figur_zustand: 'fertig', ticket: null, postfach_offen: 0, einzelchat: [],
            },
            {
              id: 'bo', name: 'Bo', stufe: 'mitglied', team: 'entwicklung', spezialgebiet: 'Tests',
              figur: { art: 'roboter', rolle: 'tester', farbe: '' }, modell: 'ornith-35b', maschine: 'mac',
              zustand: 'arbeitet', zustand_text: 'Schreibt WebKit-Tests', figur_zustand: 'arbeitet', ticket: 'T-43', postfach_offen: 0, einzelchat: [],
            },
          ],
          tickets: [
            {
              id: 'T-44', titel: 'Tab-Leiste auf dem iPad festlegen', ziel: 'Entscheiden, ob die Tab-Leiste auf dem iPad unten bleibt oder wie in iPadOS 18 oben schwebt.',
              stand: 'braucht dich', kind: 'task', prioritaet: 1, prioritaet_text: 'hoch', ampel: 'gelb', bearbeiter: 'kern', adressaten: ['mensch'],
              geaendert: iso(28), fertig_punkte: [{ text: 'Entscheidung dokumentiert', erledigt: false }],
              verlauf: [{ zeit: iso(28), ereignis: 'flagge', von: 'kern', text: 'Braucht eine Entscheidung von alice.' }], ergebnis: null,
            },
            {
              id: 'T-39', titel: 'Signaturprüfung gegen Replay absichern', ziel: 'Nonce, Zähler und request_id werden atomar reserviert.',
              stand: 'zur Abnahme', kind: 'pruefung', prioritaet: 0, prioritaet_text: 'sofort', ampel: 'grau', bearbeiter: 'tjark', adressaten: ['kern'],
              geaendert: iso(9), fertig_punkte: [
                { text: 'Replay mit gleicher Nonce scheitert', erledigt: true },
                { text: 'Zähler rückwärts scheitert', erledigt: true },
                { text: 'Doppelte request_id liefert gespeichertes Ergebnis', erledigt: true },
              ],
              verlauf: [
                { zeit: iso(64), ereignis: 'angelegt', von: 'kern', text: 'Aus Paket 2 abgeleitet.' },
                { zeit: iso(9), ereignis: 'ergebnis', von: 'tjark', text: 'Alle drei Fälle belegt, 38 Negativtests grün.' },
              ],
              ergebnis: { text: 'Alle drei Fälle belegt, 38 Negativtests grün. Commit 4c1e9a0.', von: 'tjark', zeit: iso(9) },
            },
            {
              id: 'T-41', titel: 'Chat-Composer über der Tastatur', ziel: 'Eingabe bleibt über der Bildschirmtastatur, ohne Zoom beim Fokus.',
              stand: 'läuft', kind: 'story', prioritaet: 1, prioritaet_text: 'hoch', ampel: 'grau', bearbeiter: 'ada', adressaten: ['ada'],
              geaendert: iso(3), fertig_punkte: [
                { text: 'visualViewport setzt die sichtbare Höhe', erledigt: true },
                { text: 'Schrift mindestens 16 px', erledigt: true },
                { text: 'Gerätetest auf dem iPhone XS', erledigt: false },
              ],
              verlauf: [{ zeit: iso(30), ereignis: 'angenommen', von: 'ada', text: '' }], ergebnis: null,
            },
            {
              id: 'T-43', titel: 'WebKit-Tests für History und Zurück', ziel: 'Zurück geht aus dem Detail zur Liste und wechselt nie den Tab.',
              stand: 'läuft', kind: 'task', prioritaet: 2, prioritaet_text: 'normal', ampel: 'grau', bearbeiter: 'bo', adressaten: ['bo'],
              geaendert: iso(12), fertig_punkte: [], verlauf: [], ergebnis: null,
            },
            {
              id: 'T-40', titel: 'Meldungsjournal zusammenführen', ziel: 'Meldungen beider Origins nach Event-ID entdoppeln.',
              stand: 'offen', kind: 'story', prioritaet: 2, prioritaet_text: 'normal', ampel: 'grau', bearbeiter: null, adressaten: [], team: 'entwicklung',
              geaendert: iso(120), fertig_punkte: [], verlauf: [], ergebnis: null,
            },
            {
              id: 'T-35', titel: 'Figuren in der Mobilansicht', ziel: 'Dieselben Agentenfiguren wie in der Werkbank.app.',
              stand: 'abgenommen', kind: 'task', prioritaet: 3, prioritaet_text: 'später', ampel: 'grau', bearbeiter: 'mira', adressaten: ['mira'],
              geaendert: iso(26 * 60), fertig_punkte: [{ text: 'Gleiche Figur je Name', erledigt: true }], verlauf: [], ergebnis: null,
              abnahme: { von: 'alice', zeit: iso(26 * 60), grund: 'erledigt', bemerkung: 'Die Figuren sitzen auf beiden Geräten.' },
            },
          ],
          fragen: [
            {
              id: 'F-12', text: 'Soll die Tab-Leiste auf dem iPad unten bleiben wie auf dem iPhone, oder wie in iPadOS 18 oben schweben?',
              optionen: ['Unten wie auf dem iPhone', 'Oben wie iPadOS 18'], empfehlung: 'Unten wie auf dem iPhone',
              ticket: 'T-44', stand: 'offen', von: 'kern', gestellt: iso(28), antwort: null, ruecknahme: null,
            },
          ],
          kanal: [
            { id: 'c1', art: 'nachricht', von: 'kern', an: ['alle'], text: 'Paket 9 hat Vorrang. Ada übernimmt T-41, Bo schreibt die Tests.', zeit: iso(30), ticket: null, betreff: '', von_mensch: false, markierung: null, offen_fuer_mensch: false },
            { id: 'c2', art: 'nachricht', von: 'ada', an: ['kern'], text: 'T-41 angenommen. Ich melde mich mit dem ersten Stand.', zeit: iso(29), ticket: 'T-41', betreff: '', von_mensch: false, markierung: null, offen_fuer_mensch: false },
            { id: 'c3', art: 'nachricht', von: 'tjark', an: ['kern', 'mensch'], text: 'T-39 ist zur Abnahme bereit: alle Replay-Fälle belegt.', zeit: iso(9), ticket: 'T-39', betreff: '', von_mensch: false, markierung: 'ergebnis', offen_fuer_mensch: true },
          ],
        },
        {
          id: 'recherche', name: 'Recherche', maschine: 'peer', fern: true,
          verbindung: { ok: false, seit: iso(47), text: 'peer antwortet nicht' },
          hauptagent: 'lotse',
          zaehler: { brauchen_dich: 0, laufen: 0, tickets_offen: 2 },
          agenten: [
            {
              id: 'lotse', name: 'Lotse', stufe: 'hauptagent', team: null, spezialgebiet: 'Recherche planen',
              figur: { art: 'kern', rolle: 'hauptagent', farbe: '' }, modell: 'claude-sonnet-5', maschine: 'peer',
              zustand: 'gestoppt', zustand_text: 'Nicht erreichbar', figur_zustand: 'nicht_einsehbar', ticket: null, postfach_offen: 0, einzelchat: [],
            },
            {
              id: 'ivo', name: 'Ivo', stufe: 'mitglied', team: 'recherche', spezialgebiet: 'Quellenprüfung',
              figur: { art: 'tier', rolle: 'quellenpruefer', farbe: '' }, modell: 'ornith-9b', maschine: 'peer',
              zustand: 'gestoppt', zustand_text: 'Nicht erreichbar', figur_zustand: 'nicht_einsehbar', ticket: 'R-7', postfach_offen: 0, einzelchat: [],
            },
          ],
          tickets: [
            {
              id: 'R-7', titel: 'Web-Push auf iOS 18 belegen', ziel: 'Quellen zu Web Push für Home-Bildschirm-Apps sammeln.',
              stand: 'wartet', kind: 'recherche', prioritaet: 2, prioritaet_text: 'normal', ampel: 'grau', bearbeiter: 'ivo', adressaten: ['ivo'],
              geaendert: iso(50), fertig_punkte: [], verlauf: [], ergebnis: null,
            },
            {
              id: 'R-8', titel: 'Zurück-Wischen in Standalone-Apps', ziel: 'Klären, ob iOS 18 im Standalone-Modus eine Zurück-Geste anbietet.',
              stand: 'offen', kind: 'recherche', prioritaet: 2, prioritaet_text: 'normal', ampel: 'grau', bearbeiter: null, adressaten: [], team: 'recherche',
              geaendert: iso(55), fertig_punkte: [], verlauf: [], ergebnis: null,
            },
          ],
          fragen: [],
          kanal: [],
        },
      ],
    },
  } as unknown as AgentsData;
  // Wie der Kern (`teamsBilden` in main/welten.ts) traegt jede Welt ihre Teams mit.
  for (const w of (agents.welten as unknown as { welten: { agenten: AgentKurz[]; teams?: unknown }[] }).welten) {
    w.teams = teamsAusAgenten(w.agenten);
  }

  const start: StartOptionen = {
    ordner: ['/Users/me/AI/claude-workbench', '/Users/me/AI/demo', '/Users/me/Knowledge', '/Users/me/AI/anlass', '/home/me/AI/omarchy-setup'],
    maschinen: maschinen.map((m) => ({ id: m.machine, name: m.name, erreichbar: m.erreichbar })),
    harnesses: [
      { id: 'claude', name: 'Claude', modelle: [
        { id: 'claude-opus-5', name: 'Claude Opus 5' },
        { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ] },
      { id: 'codex', name: 'Codex', modelle: [
        { id: 'codex-gpt-5-6-sol', name: 'GPT-5.6 Sol' },
        { id: 'codex-gpt-5-6-luna', name: 'GPT-5.6 Luna' },
        { id: 'codex-gpt-5-5', name: 'GPT-5.5' },
      ] },
      { id: 'opencode', name: 'OpenCode', modelle: [
        { id: 'opencode-gpt-5', name: 'opencode + GPT-5' },
        { id: 'opencode-ornith-9b', name: 'opencode + Ornith 9B (lokal)' },
      ] },
      { id: 'pi', name: 'Pi', modelle: [
        { id: 'ornith-35b', name: 'Ornith 1.0 35B (lokal)' },
        { id: 'qwen38-27b', name: 'qwen3.8-27b (lokal)' },
      ] },
    ],
  };

  return { maschinen, sitzungen, chats, prompts, freigaben, meldungen, agents, start };
}
