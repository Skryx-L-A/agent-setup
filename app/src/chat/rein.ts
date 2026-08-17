// EIN EINGANG FUER DIE PRUEFUNG: alles Reine der Chat-Ansicht an einer Stelle.
//
// `app/build.mjs` buendelt diese Datei nach `dist/test/chat-rein.mjs`, und
// `shell/tests/test-app-chat.sh` laedt sie in ein nacktes node -- ohne Electron,
// ohne Fenster, ohne Netz, ohne tmux. Dasselbe Muster wie bei
// `verbrauch-rechnen.mjs` und `sitzung-filter.mjs`: was eine reine Umformung
// ist, wird auch rein geprueft.
//
// Die Ansicht selbst (ansicht.ts) steht bewusst NICHT hier: sie fasst beim Bauen
// ein DOM an und liesse sich in node nicht laden.
export * from './typen';
export * from './ansichtsregel';
export * from './registry';
export * from './leser';
export * from './zuordnung';
export * from './httpsse';
export * from './acp';
export * from './bruecke';
export * from './pfadmuster';
export * from './markdown';
export * from './bildplatzhalter';
export { t, alleSchluessel, setzeSprache } from './texte';
