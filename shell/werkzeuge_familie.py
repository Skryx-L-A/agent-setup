"""werkzeuge_familie -- Formen der JSON-Familie fuer `wb-werkzeuge` (Spur S4).

Plan: ~/AI/_recherche/werkzeug-plan-2026-10-13.md (Zeile S4, Nachtraege 13:30/13:45) und
werkzeug-hub-entwurf-2026-10-13.md (5.1). Der Schreiber, die Zustaende und der Besitz
(Statusdatei, Snapshot, Fremdeintraege) kommen unveraendert aus werkzeuge_kern.py; dieses
Modul liefert nur die NATIVE FORM eines MCP-Eintrags je Harness und haengt sich ueber
`registrieren()` ueber die Haken `mcp_wert` und `eintrag` von werkzeuge_kern ein (Aufruf in wb-werkzeuge).

HUB-EINTRAG. Jeder Harness traegt nur EINEN MCP-Eintrag `werkbank` (Hub, Streamable HTTP
auf 127.0.0.1). In der Quelle ist das ein mcp-Eintrag mit transport "http", `"token": "hub"`
und einer url, in der `{harness}` durch den Formnamen ersetzt wird
(`http://127.0.0.1:8790/mcp?harness={harness}`). Das Hub-Token steht NIE in der Harness-Datei:
dort steht nur ein Verweis auf die Umgebungsvariable WB_HUB_TOKEN, die der Startweg der
Werkbank setzt (aus ~/.local/state/wb-hub/token). Ein Eintrag ohne `"token": "hub"` bleibt
ein gewoehnlicher Server (kein Header).

FORMEN (Beleg: S0, _recherche/werkzeug-messung-2026-10-13.md):
  opencode   opencode.json `mcp`; remote mit `headers` (Schema im Binary: "Headers to send
             with the request"); Umgebungsverweis `{env:VAR}` (opencode-Konfigurationssyntax)
  crush      crush.json `mcp` (nicht crushrc); Transporte stdio/http, Schluessel `headers`
             im Binary belegt; Umgebungsverweis `$VAR` (crush expandiert Werte der Datei)
  nanocoder  ~/.config/nanocoder/.mcp.json `mcpServers` (Objekt name -> Server; loadGlobalMCPConfig
             in config/mcp-config-loader.js, Ort = NANOCODER_CONFIG_DIR bzw. ~/.config/nanocoder);
             Felder transport/command/args/url/headers; `$VAR` in der Datei wird beim Laden ersetzt
             (config/env-substitution.js). NICHT agents.config.json: die rollt wb-harness-config
             als Pflichtdatei aus (Vorlage), ein Eintrag darin wuerde dort ABGEWICHEN/ueberschrieben.
  qwen       ~/.qwen/settings.json `mcpServers`; http = `httpUrl` + `headers`; `$VAR`/`${VAR}` in
             Zeichenketten der settings.json werden beim Laden ersetzt (bundled/qc-helper/docs/
             configuration/settings.md Z.43 und Z.676, features/mcp.md Z.72)
Alle anderen Formen mit Hub-Token (copilot, agy, goose, cline) sind OFFEN: Header-/Token-Weg
nicht gemessen. gptme: `headers` in [[mcp.servers]] gibt es, eine Ersetzung von Umgebungsvariablen
im Paket nicht (grep config/ und mcp/): das Token stuende als Wert in der Datei, also OFFEN.
"""
import werkzeuge_kern as kern

HUB_VAR = "WB_HUB_TOKEN"
GRUND_OHNE_TOKENWEG = "Hub-Token-Weg fuer %s nicht gemessen (Header mit Umgebungsverweis ungeklaert)"
GRUND_GPTME = ("gptme: [[mcp.servers]] kennt headers, aber keine Ersetzung von Umgebungsvariablen "
               "(config/, mcp/ im Paket): Token wuerde als Wert in der Datei stehen; Weg waere wb-hub stdio")



def ist_hub(e):
    return e.get("transport") == "http" and e.get("token") == "hub"


def _url(e, form):
    return e["url"].replace("{harness}", form or "")


def _opencode(e):
    if e["transport"] == "stdio":
        return {"type": "local", "command": [e["command"]] + list(e.get("args", [])), "enabled": True}
    w = {"type": "remote", "url": _url(e, "opencode"), "enabled": True}
    if ist_hub(e):
        w["headers"] = {"Authorization": "Bearer {env:%s}" % HUB_VAR}
    return w


def _crush(e):
    if e["transport"] == "stdio":
        return {"type": "stdio", "command": e["command"], "args": list(e.get("args", []))}
    w = {"type": "http", "url": _url(e, "crush")}
    if ist_hub(e):
        w["headers"] = {"Authorization": "Bearer $%s" % HUB_VAR}
    return w


def _qwen(e):
    if e["transport"] == "stdio":
        return {"command": e["command"], "args": list(e.get("args", []))}
    w = {"httpUrl": _url(e, "qwen")}
    if ist_hub(e):
        w["headers"] = {"Authorization": "Bearer $%s" % HUB_VAR}
    return w


def _nanocoder(e):
    if e["transport"] == "stdio":
        return {"transport": "stdio", "command": e["command"], "args": list(e.get("args", []))}
    w = {"transport": "http", "url": _url(e, "nanocoder")}
    if ist_hub(e):
        w["headers"] = {"Authorization": "Bearer $%s" % HUB_VAR}
    return w


def _mcp_wert(e, form):
    """Haken `mcp_wert`: Hub-Eintraege und die Formen crush und nanocoder; alles andere geht an den
    naechsten Haken bzw. den Kern."""
    if form == "crush":
        return _crush(e)
    if form == "nanocoder":
        return _nanocoder(e)
    if ist_hub(e):
        # Header-/Token-Weg nur fuer opencode, qwen (und crush, nanocoder oben) belegt; sonst OFFEN.
        return {"opencode": _opencode, "qwen": _qwen}.get(form, lambda _e: None)(e)
    return kern.WEITER


def _eintrag(r, art, name, e, harness, ad, state):
    """Haken `eintrag`: genauerer Grund fuer Hub-Eintraege, die OFFEN bleiben."""
    if r["zustand"] == "OFFEN" and art == "mcp" and ist_hub(e):
        form = ad.get("form") if isinstance(ad, dict) else None
        if form == "gptme":
            r["grund"] = GRUND_GPTME
        elif form and (r["grund"] or "").startswith("form "):
            r["grund"] = GRUND_OHNE_TOKENWEG % form
    return r


def registrieren():
    """Traegt die Familien-Formen in den Kern ein (idempotent)."""
    kern.adapter_registrieren("familie", mcp_wert=_mcp_wert, eintrag=_eintrag)
