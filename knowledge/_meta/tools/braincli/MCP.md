# Brain MCP

`brain mcp` startet einen lesenden MCP-Server über stdio. Er liest lokal aus
dem angegebenen Vault; er schreibt nie. `secrets/`, `IDENTITY.md`, Symlinks
und Pfade außerhalb des Vaults sind gesperrt.

## Claude Code

macOS und Linux (den Pfad zum eigenen Checkout anpassen):

```sh
claude mcp add brain -- /path/to/braincli/.venv/bin/brain --vault ~/Knowledge mcp
```

## Claude Desktop

In die lokale Claude-Desktop-Konfiguration einfügen (kein Eintrag wird durch
dieses Werkzeug automatisch angelegt):

```json
{
  "mcpServers": {
    "brain": {
      "command": "/path/to/braincli/.venv/bin/brain",
      "args": ["--vault", "/Users/you/Knowledge", "mcp"]
    }
  }
}
```

Unter Linux ersetzt man den Vaultpfad zum Beispiel durch `/home/you/Knowledge`.
Nach Änderungen an Abhängigkeiten zuerst im `braincli`-Verzeichnis `uv sync`
ausführen.
