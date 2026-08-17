// deck.typ — CONTENT ONLY.
//
// One thought per slide. A slide that needs two thoughts is two slides; a slide that
// needs a paragraph is a handout page. If the deck is a leave-behind, the missing
// spoken half belongs in speaker notes or in a separate document — not squeezed
// into 15pt lines at the bottom of the slide.

#import "theme.typ": deck, statement-slide
#import "@preview/touying:0.7.4": pause, meanwhile

#show: deck.with(
  title: "Titel des Vortrags",
  subtitle: "Was der Zuhörer nach 20 Minuten mitnimmt",
  meta: [Name · Anlass · Datum],
)

= Erster Abschnitt

== Die Überschrift ist die Aussage

Nicht das Thema. Eine Überschrift, die nur "Ergebnisse" heißt, verschenkt die einzige
Zeile, die jeder liest.

- ein Punkt
- ein zweiter Punkt

#statement-slide[Ein Satz, an dem sich das Argument dreht.]

== Eine Folie mit einer Zahl

#text(size: 96pt, weight: 600)[42 %]

Und darunter der Satz, der sagt, warum die Zahl zählt.
