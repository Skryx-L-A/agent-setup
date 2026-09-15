# Herkunft und Prüfung

Übernommen am 25.08.2026 aus `/usr/share/omarchy/default/agents/skills/omarchy` auf peer,
das dort per Symlink unter `~/.claude/skills/omarchy` hängt. Der Ordner gehört zum Paket
`omarchy` in der Fassung 4.0.0-1, Dateidatum 14.08.2026.

Quelle: `basecamp/omarchy` auf GitHub, MIT-Lizenz, 30207 Sterne, letzter Push am 24.08.2026.
Die sieben Dateien sind wörtlich übernommen; die einzige Änderung ist der Kopf von
`SKILL.md`, der die Maschinen-Einschränkung, den Lizenzsatz und den Verweis auf `HAUS.md`
trägt.

## Prüfung auf eingebettete Anweisungen

Gesucht wurde nach dem Muster, vor dem `~/.claude/CLAUDE.md` unter „Third-party content"
warnt: Text, der sich selbst über die Regeln des Agenten stellt, Rechte ausweitet oder
unbemerkt nach draußen telefoniert.

Ohne Befund im engeren Sinn. Es gibt keine Wendung wie „ignore previous", keinen Satz, der
sich über die Ausbildung des Modells stellt, kein Installationsskript und keinen versteckten
Netzaufruf. Der Skill besteht aus Anleitungen zu Befehlen, die auf der Maschine ohnehin
liegen.

Drei Stellen brauchen trotzdem eine Hausregel, und die stehen in `HAUS.md`:

1. **`contributing.md` führt nach draußen.** Der Text leitet dazu an, GitHub-Issues
   anzulegen, das Repo zu forken und Pull Requests zu öffnen. Das ist für einen Menschen
   gedacht; ein Worker darf es nicht.
2. **`omarchy debug` bietet einen Upload an.** Ohne Flags lädt der Befehl das
   Diagnoseprotokoll zu `logs.omarchy.org` und gibt eine Adresse aus, die 24 Stunden gilt.
   Der Skilltext verlangt selbst durchgehend `--no-sudo --print`, was den Upload umgeht;
   die Hausfassung macht daraus eine Pflicht.
3. **`hyprland.md` lädt zur Laufzeit fremde Dokumentation nach.** Der Skill schickt den
   Agenten vor jeder Fensterregel ins Hyprland-Wiki, weil sich die Syntax ändert. Das ist
   sachlich richtig, macht den geholten Text aber nicht zu einer Anweisung.

Positiv fällt auf, dass der Skill die Rechteausweitung selbst regelt und `sudo` gegenüber
`pkexec` bevorzugt, solange ein Terminal da ist. Er verbietet außerdem ausdrücklich, in
`/usr/share/omarchy/` zu schreiben, und nennt für jedes Ding den sicheren Ort unter
`~/.config/`.

## Warum diese Fassung und nicht die aus der Gemeinschaft

Geprüft wurden zwei Fremdfassungen. Beide beschreiben Omarchy vor der Fassung 4 und sind
gegen die installierte Maschine nachweislich falsch; die Einzelheiten stehen in
`~/.claude/skills/linux-native-design/reference/herkunft.md`. Der mitgelieferte Skill ist
die einzige Fassung, die zur installierten Maschine passt, und er altert mit ihr, weil er
aus demselben Paket kommt.
