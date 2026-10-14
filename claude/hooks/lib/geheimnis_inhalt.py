#!/usr/bin/env python3
"""Inhaltspruefung auf Geheimnisse: EINE Quelle fuer Muster, Schwelle und Ausnahmen.

Herkunft: der Scanner stand seit 2026-08-17 (Commit 11d34d9e) als Heredoc
CONTENT_SCAN_PY in hooks/bash-guard-secrets.sh. Diese Datei ist seit 2026-08-05
nicht mehr registriert, die Entscheidungslogik lebt in hooks/bash-guard.py -- dort
fehlte die Inhaltspruefung, ein Schluessel in config.py ging durch (gemessen
2026-10-09 am Live-Guard). Seither importieren beide diese Datei; der Scanner
steht nirgends sonst. `bash-guard-secrets.sh` baut CONTENT_SCAN_PY weiter als
`python3 -c`-Programm, das hierher zeigt (siehe dort).

Entropie-Schwelle 4.3 Bit/Zeichen (Shannon, ueber die Zeichenverteilung des Werts):
  UUID v4 mit Bindestrichen (36 Zeichen)      3.391
  UUID v4 ohne Bindestriche (32 Hexziffern)   3.248
  git SHA-1, 39 Hexziffern                    3.821
  zufaelliger 32-Zeichen-Schluessel           5.000
  zufaellige 40-Zeichen-Zeichenkette          5.172
Reines Hex hat die Decke log2(16) = 4.0; die Schwelle liegt darueber, aber klar
unter echten Zufallsschluesseln mit groesserem Alphabet.

Fail-closed: eine nicht lesbare Datei ist KEIN sauberer Befund (Fehler, nicht Fund).
Binaerdateien (NUL-Byte im gelesenen Ausschnitt) werden uebersprungen; gelesen werden
hoechstens MAX_BYTES je Datei -- ein Fund darin zaehlt, der Rest wird nicht gesehen.
"""
import bisect
import fnmatch
import hashlib
import math
import os
import re
import sys
from collections import Counter

MAX_BYTES = 2000000
ENTROPY_THRESHOLD = 4.3
MIN_GENERIC_LEN = 16
EXCEPTIONS_FILENAME = 'guard-secrets-content-exceptions.conf'
PUBLIC_VALUES_FILENAME = 'guard-secrets-public-values.conf'

PATTERNS = [
    ("aws_access_key", re.compile(r'AKIA[0-9A-Z]{16}')),
    ("github_token", re.compile(r'(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255}')),
    # Vordere Grenze: `(?<![A-Za-z0-9])` -- ohne sie traf `sk-` mitten in Woertern wie
    # `task-<langer-slug>` oder `disk-...` in HTML/Rohtext (Hauptquelle der Fehlalarme im
    # Scan ueber alle Repos, 2026-10-09). Ein echter Schluessel steht nach Zeichensetzung
    # (= " ' : Leerraum), nicht direkt hinter einem Buchstaben.
    ("anthropic_key", re.compile(r'(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}')),
    ("openai_key", re.compile(r'(?<![A-Za-z0-9])sk-(?!ant-)[A-Za-z0-9_-]{20,}')),
    ("slack_token", re.compile(r'xox[baprs]-[A-Za-z0-9-]{10,48}')),
    ("google_api_key", re.compile(r'AIza[0-9A-Za-z_-]{35,}')),
    ("private_key_block", re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ("jwt", re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    ("stripe_key", re.compile(r'(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}')),
    # Seit 2026-10-09, an Primaerquellen belegt (abgerufen 2026-10-09):
    #  - Hugging Face: gitleaks config/gitleaks.toml, Commit b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b,
    #    Regel huggingface-access-token (Zeile 2363-2368): `\b(hf_(?i:[a-z]{34}))` + Abschluss.
    #  - Groq: trufflehog pkg/detectors/groq/groq.go:25, Commit 0e427395344c7039c0b15a1147f5782805685b3e:
    #    `\b(gsk_[a-zA-Z0-9]{52})\b` (gitleaks hat keine Groq-Regel).
    #  - Telegram: gitleaks (gleicher Commit) Regel telegram-bot-api-token (Zeile 3104-3108):
    #    `<5-16 Ziffern>:A<34 Zeichen [a-z0-9_-]>`, dort nur mit Schluesselwort `telegr` davor
    #    (Zuweisung); ohne dieses Schluesselwort wuerde die Ziffern-Doppelpunkt-Form zu oft in
    #    Zeitstempeln und IDs treffen, deshalb hier ebenfalls nur mit Kontext.
    # Broker (Alpaca u. a.) haben KEIN eindeutiges Praefix; ihre Schluessel faengt die generische
    # Zuweisung (…API_KEY, …SECRET_KEY = <Wert>) ueber die Entropie.
    ("huggingface_token", re.compile(r'(?<![A-Za-z0-9_])hf_[A-Za-z]{34}(?![A-Za-z0-9_])')),
    ("groq_key", re.compile(r'(?<![A-Za-z0-9_])gsk_[A-Za-z0-9]{52}(?![A-Za-z0-9_])')),
    ("telegram_bot_token", re.compile(
        r'(?i:telegr[\w .-]{0,20}[\s\'"]{0,3}(?:=|:|=>|,)[`\'"\s=]{0,5})[0-9]{5,16}:A[A-Za-z0-9_-]{34}')),
    # Seit 2026-10-10 (Anlass: ein Client-Secret samt Client-ID aus einer weitergeleiteten Mail
    # stand am 09.10. im Toolergebnis; die generische Zuweisung greift nur mit `secret` + `:`/`=`
    # davor, nicht bei `Client-Secret GOCSPX-...`, in einem Satz oder allein):
    #  - Google-OAuth-Clientgeheimnis: Praefix `GOCSPX-` plus 28 Zeichen [A-Za-z0-9_-] (35 Zeichen
    #    gesamt). Google selbst veroeffentlicht kein Format; belegt ist die Form nur durch den
    #    Detektor-Praefix bei GitGuardian (docs.gitguardian.com ... /google_oauth2_keys, "Prefixed:
    #    True", Beispielwert mit 28 Zeichen nach dem Praefix) und GitHub-Secret-Scanning
    #    (Typ google_oauth_client_secret; docs.github.com ... /supported-secret-scanning-patterns,
    #    ohne Regel), abgerufen 2026-10-10. Darum `{28,}` statt exakt 28: ein laengerer Wert wird
    #    ganz erfasst, nicht am Ende abgeschnitten. Gitleaks hat KEINE Regel dafuer.
    #    Vordere Grenze wie bei anthropic_key. Die zugehoerige Client-ID
    #    (`<Ziffern>-<Hash>.apps.googleusercontent.com`) steht bewusst NICHT hier: sie ist ein
    #    oeffentlicher Bezeichner (steht in jeder OAuth-Weiterleitungs-URL und in Web-/App-Quelltext),
    #    ein Treffer wuerde Commits mit legitimer Konfiguration blocken. Alle Nutzer dieser Liste
    #    behandeln jeden Treffer als Sperre; eine Hinweis-Ebene gibt es nicht.
    #  - AWS-Sitzungsschluessel (STS, temporaer): Praefix ASIA statt AKIA, gleiche Form. Beleg:
    #    gitleaks config/gitleaks.toml, Regel aws-access-token, `\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)
    #    [A-Z2-7]{16})\b`, abgerufen 2026-10-10. Nur ASIA ergaenzt (neben AKIA die gaengige Form,
    #    taucht in `aws sts`-Ausgaben und Umgebungen auf); ABIA/ACCA/A3T ohne eigenen Beleg ausgelassen.
    #    Grenzen beidseitig, weil `ASIA` ein ueblicher Wortanfang in Grossbuchstaben-Text ist.
    ("google_oauth_client_secret", re.compile(r'(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{28,}')),
    ("aws_session_key", re.compile(r'(?<![A-Z0-9])ASIA[A-Z2-7]{16}(?![A-Z0-9])')),
    # Seit 2026-10-10 (Auftrag musterlisten-lib): vier Praefixe, die die Praefixliste in
    # shell/wb-state (SECRET_PREFIXES) schon abwies und diese Liste nicht kannte. Formquellen,
    # abgerufen 2026-10-10; Falschtreffer vorher/nachher gemessen ueber den Arbeitsbaum, den Vault
    # ohne secrets und die Repos unter ~/AI (rund 82700 Textdateien): je Muster 0 neue Treffer.
    #  - GitLab-Zugriffstoken: gitleaks config/gitleaks.toml, Commit b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b,
    #    Regel gitlab-pat (Zeile 2228): Praefix glpat- plus 20 Zeichen aus [\w-]; die Variante gitlab-pat-routable
    #    (Zeile 2235) beginnt gleich und ist laenger. Darum hier `{20,}`: ein laengerer Wert wird ganz erfasst.
    #    Vordere Grenze inklusive `-`, weil der Wert selbst aus [\w-] besteht.
    #  - DigitalOcean-Zugriffstoken: gleicher Commit, Regel digitalocean-pat (Zeile 410): Praefix dop_v1_
    #    plus genau 64 Hexziffern, abgeschlossen durch ein Nicht-Wortzeichen.
    #  - Square-Zugriffstoken: gleicher Commit, Regel square-access-token (Zeile 3063):
    #    `(?:EAAA|sq0atp-)[\w-]{22,60}`. Nur die sq0atp-Haelfte: EAAA beginnt auch Base64-Daten (nicht
    #    gemessen, darum nicht aufgenommen).
    #  - xAI-Schluessel: trufflehog pkg/detectors/xai/xai.go:28, Commit 0e427395344c7039c0b15a1147f5782805685b3e:
    #    `\b(xai-[0-9a-zA-Z_]{80})\b` (gitleaks hat keine xAI-Regel).
    # NICHT aufgenommen: ya29. (Google-OAuth-Zugriffstoken). GitHub-Secret-Scanning fuehrt den Typ
    # google_oauth_access_token (docs.github.com ... /supported-secret-scanning-patterns), nennt aber
    # keine Form; gitleaks (gleicher Commit) und trufflehog haben keine Regel dafuer. Ohne Formquelle
    # keine Laenge und keine Grenze -- die Praefixliste in wb-state faengt ya29. weiter ab.
    ("gitlab_pat", re.compile(r'(?<![A-Za-z0-9_-])glpat-[0-9A-Za-z_-]{20,}')),
    ("digitalocean_pat", re.compile(r'(?<![A-Za-z0-9_])dop_v1_[a-f0-9]{64}(?![A-Za-z0-9_])')),
    ("square_access_token", re.compile(r'(?<![A-Za-z0-9_])sq0atp-[0-9A-Za-z_-]{22,60}')),
    ("xai_key", re.compile(r'(?<![A-Za-z0-9_])xai-[0-9a-zA-Z_]{80}(?![A-Za-z0-9_])')),
]

# Ein Wert wie `modul._CONTROLLER_ACTOR_BINDING.set` ist ein Ausdruck, kein Schluessel:
# Kette aus Bezeichnern mit Punkten. Sonst loest `token = obj.attr.methode(...)` im Code
# bei Entropie knapp ueber der Schwelle aus (Testfixtur shell/tests/herkunft_fixture.py).
_BEZEICHNER_KETTE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+')

# Keine vordere Wortgrenze: '\b' greift NICHT vor dem S in STRIPE_SECRET, weil der
# Unterstrich selbst ein Wortzeichen ist -- ein Praefix wie STRIPE_, AZURE_CLIENT_ oder
# DB_ haette den Fund sonst still verhindert (gemessen am 17.08.2026). Ein Fehlalarm
# bleibt unwahrscheinlich, weil zusaetzlich ein Wert von mindestens MIN_GENERIC_LEN
# Zeichen UND eine Entropie ueber der Schwelle verlangt wird.
GENERIC_ASSIGN = re.compile(
    r'(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret)\b'
    r'\s*[:=]\s*["\']?([A-Za-z0-9+/_=\-~.]{%d,})["\']?' % MIN_GENERIC_LEN
)


def shannon_entropy(s):
    if not s:
        return 0.0
    counts = Counter(s)
    length = len(s)
    return -sum((c / length) * math.log2(c / length) for c in counts.values())


def load_public_values(hooks_dir):
    """SHA-256-Hexwerte bekannter oeffentlicher Werte (guard-secrets-public-values.conf).
    Fehlt die Datei oder ist sie nicht lesbar: leere Menge -- nie weniger melden."""
    try:
        with open(os.path.join(hooks_dir, PUBLIC_VALUES_FILENAME), encoding='utf-8') as f:
            lines = f.read().splitlines()
    except Exception:
        return frozenset()
    werte = set()
    for ln in lines:
        if not ln or ln.startswith('#'):
            continue
        tok = ln.split()[0].lower()
        if re.fullmatch(r'[0-9a-f]{64}', tok):
            werte.add(tok)
    return frozenset(werte)


def _oeffentlich(treffer, public):
    """Genau diese Zeichenkette steht auf der Liste -- Vergleich des Werts, kein Muster."""
    return bool(public) and hashlib.sha256(treffer.encode('utf-8')).hexdigest() in public


# Quoted-Printable-Softbreak: ein `=` am Zeilenende, das die Zeile fortsetzt (RFC 2045). Ein Mail-Text
# bricht so mitten in einem Wert um (`...GOC=` / `SPX-...`), und jedes Muster oben sieht dann zwei Haelften.
# Bei einer weitergeleiteten Mail steht vor der Fortsetzung noch das Zitatzeichen (`> `); es gehoert zum
# Umbruch. Gemessen 2026-10-10 an rund 5000 Textdateien mit solchen Zeilenenden (Arbeitsbaum, Vault ohne
# secrets, Repos unter ~/AI): kein einziger Treffer, der erst durch das Verbinden entsteht.
_QP_UMBRUCH = re.compile(r'=\r?\n(?:[ \t]*>[> \t]*)?')


def _qp_verbinden(text):
    """(verbunden, orte, summen): `text` ohne Softbreaks; `orte[i]` ist die Stelle des i-ten Softbreaks im
    VERBUNDENEN Text, `summen[i]` die Zahl der bis dahin (einschliesslich) entfernten Zeichen."""
    teile, orte, summen, pos, weg = [], [], [], 0, 0
    for m in _QP_UMBRUCH.finditer(text):
        teile.append(text[pos:m.start()])
        orte.append(m.start() - weg)
        weg += m.end() - m.start()
        summen.append(weg)
        pos = m.end()
    teile.append(text[pos:])
    return "".join(teile), orte, summen


def _qp_treffer(text, public, alle, gemeldet):
    """Provider-Muster, die erst NACH dem Verbinden der Softbreaks treffen. Gemeldet wird der Ausschnitt
    des ORIGINALTEXTS samt Umbruechen (`text[von:bis]`), nicht der verbundene Wert: so findet ihn der
    Git-Hook im alten Blob wieder (`wert in alt_text`) und kann ihn der Filter im Strom ersetzen."""
    verbunden, orte, summen = _qp_verbinden(text)
    if not orte:
        return
    for name, rx in PATTERNS:
        if not alle and name in gemeldet:
            continue
        for m in rx.finditer(verbunden):
            i = bisect.bisect_right(orte, m.start())
            von = m.start() + (summen[i - 1] if i else 0)
            j = bisect.bisect_left(orte, m.end())
            bis = m.end() + (summen[j - 1] if j else 0)
            if bis - von == m.end() - m.start():
                continue  # kein Softbreak im Treffer: der Durchlauf auf dem Originaltext hat ihn schon
            if _oeffentlich(m.group(0), public):
                continue
            yield text.count("\n", 0, von) + 1, name, text[von:bis], None
            if not alle:
                break


def treffer(text, generisch=True, public=frozenset(), alle=True):
    """Jeder Treffer in `text` als (Zeile, Regel, Wert, Entropie): Provider-Muster zuerst (in
    der Reihenfolge von PATTERNS, Entropie None), danach die gleichen Muster ueber den Text ohne
    Quoted-Printable-Softbreaks (nur Treffer, die einen Umbruch ueberspannen; der Wert ist dann der
    Originalausschnitt MIT dem Umbruch), danach die generische Zuweisung (Regel = Schluesselwort,
    nur mit generisch=True). alle=False: je Provider-Muster nur der erste nicht-oeffentliche
    Treffer (so meldet scan_file). Der Wert verlaesst den Aufrufer nie in eine Ausgabe -- er dient
    nur dem Vergleich (Git-Hook: stand er schon im alten Blob?)."""
    gemeldet = set()
    for name, rx in PATTERNS:
        for m in rx.finditer(text):
            if _oeffentlich(m.group(0), public):
                continue
            yield text.count("\n", 0, m.start()) + 1, name, m.group(0), None
            gemeldet.add(name)
            if not alle:
                break

    if '=\n' in text or '=\r\n' in text:
        yield from _qp_treffer(text, public, alle, gemeldet)

    for m in (GENERIC_ASSIGN.finditer(text) if generisch else ()):
        value = m.group(2)
        if _BEZEICHNER_KETTE.fullmatch(value):
            continue
        if _oeffentlich(value, public):
            continue
        ent = shannon_entropy(value)
        if ent >= ENTROPY_THRESHOLD:
            yield text.count("\n", 0, m.start()) + 1, m.group(1), value, ent


def scan_file(path, generisch=True, public=frozenset()):
    """(Funde, Fehler): Funde ist eine Liste von Texten, Fehler None oder ein Text.
    generisch=False schaltet NUR die Entropie-Zuweisungsregel ab; die Provider-Muster
    gelten immer. `public`: SHA-256-Hexwerte exakter oeffentlicher Treffer, die nicht
    gemeldet werden (jeder Treffer eines Musters wird geprueft, nicht nur der erste)."""
    findings = []
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_BYTES)
    except Exception as e:
        return None, "%s: %s" % (path, e)

    if b"\x00" in data:
        return [], None  # binaer -> uebersprungen, kein Fehler

    text = data.decode("utf-8", errors="replace")

    for line, regel, _wert, ent in treffer(text, generisch, public, alle=False):
        if ent is None:
            findings.append("%s: Zeile %d, Muster '%s'" % (path, line, regel))
        else:
            findings.append(
                "%s: Zeile %d, generische Zuweisung '%s' mit hoher Entropie (%.2f Bit/Zeichen)"
                % (path, line, regel, ent)
            )

    return findings, None


def scan_paths(paare, generisch_aus=(), public=frozenset()):
    """Paare (relativer Pfad, absoluter Pfad) pruefen. -> (erster Fund oder None,
    erster Fehler oder None). Auf Pfade, die zu `generisch_aus` passen, wirkt nur
    die Provider-Mustersuche."""
    first_finding = None
    first_error = None
    for rel, ab in paare:
        findings, err = scan_file(ab, generisch=not is_exempt(rel, generisch_aus), public=public)
        if err is not None:
            if first_error is None:
                first_error = err
            continue
        if findings and first_finding is None:
            first_finding = findings[0]
    return first_finding, first_error


def load_exceptions(hooks_dir):
    """(volle Ausnahmen, nur-Entropie-Ausnahmen) aus guard-secrets-content-exceptions.conf.
    Zeile `generisch: <glob>` nimmt eine Datei nur von der Entropie-Zuweisungsregel aus
    (Provider-Muster gelten weiter), jede andere Zeile ganz von der Inhaltspruefung.
    Fehlt die Datei oder ist sie nicht lesbar: keine Ausnahme -- nie weniger scannen."""
    path = os.path.join(hooks_dir, EXCEPTIONS_FILENAME)
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.read().splitlines()
    except Exception:
        return [], []
    voll, generisch = [], []
    for ln in lines:
        if not ln or ln.startswith('#'):
            continue
        if ln.startswith('generisch:'):
            muster = ln[len('generisch:'):].strip()
            if muster:
                generisch.append(muster)
        else:
            voll.append(ln)
    return voll, generisch


def is_exempt(rel_path, patterns):
    """Glob gegen den repo-relativen Pfad, case-sensitive, `*` matcht auch `/`
    (wie `case` in bash)."""
    return any(fnmatch.fnmatchcase(rel_path, pat) for pat in patterns)


# Eigene Remotes und die Zweige, deren Spitze als "geprueft und veroeffentlicht" gilt. Nur
# main/master: ein Push dahin lief durch die Pruefung des Hauptagenten, und die Menge bleibt
# klein -- ein beliebiger Zweig (auch ein geholter Fremdzweig) zaehlt nicht.
EIGENE_REMOTES = ('origin', 'forgejo')
VEROEFFENTLICHT_ZWEIGE = ('main', 'master')


def merge_uebernommen(repo_dir, index_pfade, run_git):
    """Pfade des Index, die ein laufender Merge (MERGE_HEAD, auch Octopus) unveraendert aus
    VEROEFFENTLICHTEM Stand uebernimmt: ihr Index-Blob ist gleich dem Blob desselben Pfads an
    der Spitze von refs/remotes/<eigener Remote>/<main|master>. Dieser Inhalt ist schon geprueft
    und veroeffentlicht und wird mit dem Merge-Commit nicht neu eingefuehrt -- ein
    Test-Dummy-Schluessel aus main wuerde sonst jeden Worker blocken, der main einmischt
    (gemessen 2026-10-09). Ein Merge-Elternteil allein reicht NICHT: ein lokaler oder geholter
    Fremdzweig, der nie durch diesen Guard lief, brachte sonst einen Schluessel ungeprueft durch.
    Fail-closed: ohne MERGE_HEAD, bei jedem git-Fehler, bei einem Pfad ohne Stufe 0 (Konflikt)
    und bei jedem Pfad, dessen Blob an keiner dieser Spitzen so liegt, ist die Menge leer bzw.
    fehlt der Pfad -- er bleibt Kandidat der Inhaltspruefung. Eine fehlende Ref ist normal
    (kein forgejo-Remote) und hebt nichts aus.
    Gemeinsam fuer bash-guard.py (Text-Guard) und den Git-Hook-Verteiler (claude/git-hooks/
    _verteiler, prepare-commit-msg); `run_git(args)` -> stdout oder None bei Fehler."""
    if not index_pfade:
        return set()
    if run_git(['-C', repo_dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']) is None:
        return set()
    index = run_git(['-C', repo_dir, 'ls-files', '-s', '-z'])
    if index is None:
        return set()
    stufe0 = {}
    konflikt = set()
    for eintrag in index.split('\0'):
        kopf, tab, pfad = eintrag.partition('\t')
        felder = kopf.split()
        if not tab or len(felder) != 3:
            continue
        if felder[2] == '0':
            stufe0[pfad] = felder[1]
        else:
            konflikt.add(pfad)
    gesucht = set(index_pfade)
    frei = set()
    for remote in EIGENE_REMOTES:
        for zweig in VEROEFFENTLICHT_ZWEIGE:
            baum = run_git(['-C', repo_dir, 'ls-tree', '-r', '-z',
                            'refs/remotes/%s/%s' % (remote, zweig)])
            if baum is None:
                continue
            for eintrag in baum.split('\0'):
                kopf, tab, pfad = eintrag.partition('\t')
                felder = kopf.split()
                if (tab and len(felder) == 3 and felder[1] == 'blob' and pfad in gesucht
                        and pfad not in konflikt and stufe0.get(pfad) == felder[2]):
                    frei.add(pfad)
    return frei


def main(argv=None):
    """Kommandozeilenform des alten Heredocs: Pfade als Argumente, je Zeile
    `FINDING:`/`ERROR:`, Exit 0; unerwarteter Fehler: `FATAL:` und Exit 1."""
    paths = (sys.argv[1:] if argv is None else argv)
    try:
        # Aufrufer ohne Repo-Bezug (alte Kette): die Globs der Ausnahmedatei beginnen
        # mit `*`, passen also auch auf den absoluten Pfad.
        _voll, generisch = load_exceptions(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
        public = load_public_values(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
        for p in paths:
            findings, err = scan_file(p, generisch=not is_exempt(p, generisch), public=public)
            if err is not None:
                print("ERROR:%s" % err)
                continue
            for f in findings:
                print("FINDING:%s" % f)
    except Exception as e:
        print("FATAL:%s" % e)
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
