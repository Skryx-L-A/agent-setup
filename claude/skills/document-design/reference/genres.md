# Document genres — decide this before the first character

A document is not defined by its file format but by **how it is read**. That is the one
fact every other decision follows from, and it is the fact that gets skipped.

Six genres. Find the one the request belongs to, read its row, and carry the "decides the
quality" column into `tokens.typ`. If a request straddles two, say so and pick the one
that wins — a document that serves two reading modes serves neither.

The split is deliberately *not* the one the screen-design skills use (impeccable's
Persuade / Operate / Read / Experience). Those describe what an interface is *for*. On
paper the useful question is different: how long the reader stays, in which order they
move, and whether they can leave and come back. A landing page and an invitation are
both "persuade" and have nothing else in common.

---

## 1. Lesestrecke — read from front to back

Bericht, Studie, Whitepaper, Essay, Buchkapitel, Gutachten.

- **Reading mode:** linear, minutes to hours, one column, no jumping.
- **Decides the quality:** a text column that does not tire. Measure (60–72 characters),
  even leading on a grid, restrained hierarchy, consistent page rhythm.
- **Page rhythm:** every page looks like the one before. Variation is a defect here.
- **Typical failure:** designed like a brochure — pull quotes, boxes, three colours,
  a different layout every second page.
- **Give it:** one text face for the body, one other voice for headings and furniture,
  a note column for what would otherwise interrupt, page numbers and running heads.

## 2. Nachschlagewerk — read by jumping in

Handbuch, Dokumentation, Spezifikation, Katalog, Preisliste, Prozessbeschreibung.

- **Reading mode:** the reader arrives with a question and leaves with an answer.
  Nobody reads page 34 after page 33.
- **Decides the quality:** findability. Predictable position of every element,
  running heads that name the *section* (not the document), numbered headings,
  a table of contents that matches, an index or a marginal keyword column.
- **Page rhythm:** strictly repeating; a heading always at the same height.
- **Typical failure:** beautiful and unnavigable — no folios, no running heads, headings
  that only differ in size, a table that continues over a page break without repeating
  its head.
- **Give it:** numbered sections, a marginal column for keywords, tables built to be
  scanned across rows, and a version/date on every page if it is a living document.

## 3. Entscheidungsvorlage — read by someone deciding

Angebot, Pitch, Antrag, Businessplan, Exposé, Projektskizze.

- **Reading mode:** three minutes, sceptical, often on a phone, then filed or forwarded.
- **Decides the quality:** the first fifteen seconds. One claim per page, the number set
  as a number and not buried in a sentence, the price/date/decision visible without
  searching, a first page that survives being the only page read.
- **Page rhythm:** front-loaded — the strongest page is page one, not the appendix.
- **Typical failure:** the argument hidden in continuous prose; the price on page 7;
  a cover that says only the company name.
- **Give it:** a summary that is genuinely a summary, figures set in tabular numerals,
  a visible structure of exactly the questions the reader has (what, when, how much,
  who, what happens if not).

## 4. Selbstdarstellung — read in comparison with forty others

Lebenslauf, Portfolio, Profil, Einseiter, Bewerbung.

- **Reading mode:** 20–40 seconds, in a stack, against competitors.
- **Decides the quality:** scannable structure plus exactly one distinctive, quiet formal
  decision. Dates and roles findable at a glance; nothing decorative competing with them.
- **Page rhythm:** one page unless the field demands two. The second page must not be
  the first one's leftovers.
- **Typical failure:** the template look (grey sidebar, skill bars, icon list), or
  decoration used where structure is missing. Both read as "no judgement".
- **Give it:** a strict left edge, one alignment axis for all dates, real hierarchy
  between role and employer, and no rating graphics — a bar chart of "Photoshop 80 %"
  says nothing and looks the same on every CV.

## 5. Anlass — looked at, not read

Einladung, Karte, Urkunde, Zertifikat, Programm, Menü, Plakat.

- **Reading mode:** seconds, often held in the hand, sometimes kept.
- **Decides the quality:** one gesture and generous emptiness. Format, paper and
  proportion do more work than any element on the page.
- **Page rhythm:** a single composition; there is no "next page" to be consistent with.
- **Typical failure:** filling the space. Gradient background, script font, centred
  everything, a border because the middle looked empty.
- **Give it:** an unusual but justified format, one strong size contrast, real margins
  (an invitation tolerates 40 mm of nothing), and the practical facts (when, where, RSVP)
  set as calmly as the rest.

## 6. Vortragsstütze — seen from four metres, or read alone

Deck, Foliensatz, Pitchdeck.

- **Reading mode:** two documents wearing one name. Support for a talk: seen for 40
  seconds while someone speaks. Leave-behind: read alone, without the speaker.
- **Decides the quality:** deciding which of the two it is, and saying so. Support wants
  few words at 22 pt and up; a leave-behind wants the spoken half written down —
  in speaker notes or a companion document, never squeezed into 12 pt at the slide foot.
- **Page rhythm:** one thought per slide; the section openers are the reader's map.
- **Typical failure:** the deck that tries to be both — too dense to project, too thin
  to read.
- **Give it:** a decision in `tokens.typ` (`Purpose:`), body size that survives the back
  row, and one headline per slide that states the claim rather than naming the topic.

---

## When the request does not name a genre

Ask one question, not five: *"Wer liest das, und wie lange?"* The answer places the
document in the grid above. If no answer is available, state the assumption in one line
at the top of `tokens.typ` and build on it — an assumption written down can be corrected;
an unspoken one cannot.
