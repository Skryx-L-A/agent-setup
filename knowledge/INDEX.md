# INDEX — wo was liegt

Dieser Wissensspeicher startet leer. Die Zweige stehen schon, die Notizen sind Deine.

Gesucht wird mit `brain search "<frage>" -k 5` — Hybridsuche aus BM25 und Embeddings, lokal, in
der Groessenordnung einer Drittelsekunde. Diese Datei ist der Notnagel fuer den Fall, dass die
Suche nichts Brauchbares liefert und Du wissen musst, in welchem Zweig ein Thema ueberhaupt
liegen muesste.

## Die Zweige

| Zweig | Was hineingehoert |
|---|---|
| `00-sources/` | Rohmaterial, das jemand anderes geschrieben hat: Mitschriften, Exporte, kopierte Artikel. Wird nie umgeschrieben. |
| `10-global/` | Was ueber Projekte hinweg gilt: Aufbauten, Entscheidungen, Vorfaelle, Dein eigenes Profil. |
| `20-projects/<projekt>/` | Alles zu einem Projekt. Pro Projekt ein Ordner, darin eine `STATUS.md` und die Session-Notizen. |
| `30-topics/<thema>/` | Themenseiten, die aus mehreren Notizen verdichtet sind. Abgeleitet: bei einer Entscheidung, einer Zahl oder einer Zusage gilt die Quellnotiz, nicht die Themenseite. |
| `40-people/` | Menschen mit Rolle und Verantwortung, ein kleines CRM. |
| `_assets/` | Binaerdateien. Je Datei eine Stub-Notiz nach `_meta/templates/asset-stub.md`, damit sie im Graph auftaucht. |
| `_meta/templates/` | Die Vorlagen. Jede neue Notiz entsteht aus einer davon. |
| `_meta/tools/` | Die Werkzeuge: `braincli` (Suche und Index), `gardener` (Verdichten, Widersprueche, Verwaisungen), die git-Hooks. |

Ein Thema, das zu keinem bestehenden Ordner passt, bekommt einen eigenen — ohne Rueckfrage. Ein
Zweig, den es nicht gibt, ist der haeufigste Grund dafuer, dass etwas gar nicht abgelegt wird.

## Was hier nie liegt

`90-secrets/` ist im Original per Maschine getrennt und wird nie synchronisiert. Wenn Du einen
solchen Zweig anlegst, gehoert er in `.gitignore`, bevor die erste Datei darin entsteht.
`IDENTITY.md` sagt, wer auf dieser Maschine sitzt, und wird ebenfalls nie eingecheckt — die
Vorlage dafuer ist `IDENTITY.md.example`.

## Erste Schritte

1. `IDENTITY.md.example` kopieren, ausfuellen, nicht committen.
2. `_meta/tools/braincli` und `_meta/tools/gardener` mit `uv sync` einrichten.
3. Die erste Notiz aus `_meta/templates/note.md` schreiben. `beispiele/notiz.md` im Repo zeigt,
   wie eine fertige aussieht.
4. `brain search` einmal laufen lassen. Der Index entsteht dabei; nichts davon wird mitgeliefert.
