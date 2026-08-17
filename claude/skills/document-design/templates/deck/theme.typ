// theme.typ — the MECHANICS of the deck, built directly on Touying's primitives instead
// of on one of its shipped themes. That is deliberate: a shipped theme is a finished
// design, and using it means the deck was designed by whoever wrote the theme.
// Touying gives the machinery (slide functions, subslides, counters); the look is decided
// here and in tokens.typ, every time.
//
// Touying 0.7.4. Docs: https://touying-typ.github.io/

#import "@preview/touying:0.7.4": *
#import "tokens.typ" as t

#let _gate() = assert(
  t.design-decided,
  message: "Layout for this deck has not been decided yet.\n"
    + "Open tokens.typ, answer the Purpose question at the top, replace every value with\n"
    + "your own decision for THIS deck, write the reason on each `why:` line, then set\n"
    + "design-decided = true. Do not simply flip the flag.",
)

#let u(n) = n * t.unit

// --- The ordinary slide -----------------------------------------------------
// Headline top-left, content below, furniture in the bottom margin. Deliberately plain:
// a slide layout that draws attention to itself competes with the person talking.
#let slide(config: (:), repeat: auto, setting: body => body, composer: auto, ..bodies) = {
  touying-slide-wrapper(self => {
    let footer(self) = {
      set text(size: t.size.small, fill: t.ink.soft, font: t.font-display)
      grid(
        columns: (1fr, auto),
        align: (left + bottom, right + bottom),
        if t.show-running-title { utils.display-current-heading(level: 1) } else { [] },
        if t.show-slide-numbers { context utils.slide-counter.display() } else { [] },
      )
    }
    let self = utils.merge-dicts(self, config-page(footer: footer))
    touying-slide(
      self: self,
      config: config,
      repeat: repeat,
      setting: setting,
      composer: composer,
      ..bodies,
    )
  })
}

// --- Openers ----------------------------------------------------------------
#let title-slide(title: "", subtitle: none, meta: none) = touying-slide-wrapper(self => {
  let self = utils.merge-dicts(self, config-common(freeze-slide-counter: true))
  touying-slide(self: self, {
    set align(left + horizon)
    block[
      #line(length: 40%, stroke: 4pt + t.ink.accent)
      #v(u(3))
      #text(size: t.size.title, font: t.font-display, weight: 600, hyphenate: false, title)
      #if subtitle != none {
        v(u(2))
        text(size: t.size.h2, font: t.font-text, fill: t.ink.soft, hyphenate: false, subtitle)
      }
      #if meta != none {
        v(u(6))
        text(size: t.size.small, font: t.font-display, fill: t.ink.soft, meta)
      }
    ]
  })
})

#let section-slide(config: (:), body) = touying-slide-wrapper(self => {
  touying-slide(self: self, config: config, {
    set align(left + horizon)
    text(size: t.size.h1, font: t.font-display, weight: 600, fill: t.ink.accent, {
      utils.display-current-heading(level: 1)
    })
    body
  })
})

// A slide that carries one sentence and nothing else. Use it where the argument turns —
// not as decoration. If every third slide is one of these, none of them lands.
#let statement-slide(body) = touying-slide-wrapper(self => {
  // Without this the slide inherits the headline of the section it stands in, and the
  // one sentence it exists for arrives under someone else's title.
  let self = utils.merge-dicts(self, config-common(subslide-preamble: none))
  touying-slide(self: self, {
    set align(left + horizon)
    set par(leading: u(3), justify: false)
    text(size: t.size.h1, font: t.font-display, weight: 600, hyphenate: false, body)
  })
})

// --- The deck ---------------------------------------------------------------
#let deck(title: "", subtitle: none, meta: none, ..args, body) = {
  _gate()

  show: touying-slides.with(
    config-page(
      ..utils.page-args-from-aspect-ratio(t.aspect-ratio),
      margin: t.margin,
      fill: t.ink.bg,
      footer-descent: u(1),
    ),
    // Touying consumes the level-2 heading as the slide separator, so it is NOT rendered
    // by a show rule — the preamble is what puts the headline back on the slide.
    // Without this, every content slide silently loses its headline. Seen in the render.
    config-common(
      slide-fn: slide,
      new-section-slide-fn: section-slide,
      // Touying's default (`zero-margin-footer: true`) negative-pads the footer so it
      // spans the full physical page width, ignoring `margin` for that band only — the
      // slide number then sits flush against the paper edge and gets clipped there.
      // Confirmed in Touying 0.7.4 src/core.typ `_get-negative-pad` / `_get-header-footer`.
      zero-margin-footer: false,
      subslide-preamble: block(
        below: 32pt,
        text(
          size: t.size.h2,
          font: t.font-display,
          weight: 600,
          hyphenate: false,
          utils.display-current-heading(level: 2),
        ),
      ),
    ),
    config-methods(init: (self: none, body) => {
      set text(
        font: t.font-text,
        size: t.body-size,
        fill: t.ink.text,
        lang: t.lang,
        top-edge: 0.75em,
        bottom-edge: -0.25em,
      )
      set par(leading: t.line-height - t.body-size, justify: false, spacing: u(3))
      set list(marker: [–], spacing: u(3), body-indent: u(1.5))
      set enum(spacing: u(3), body-indent: u(1.5))
      body
    }),
    ..args,
  )

  title-slide(title: title, subtitle: subtitle, meta: meta)
  body
}
