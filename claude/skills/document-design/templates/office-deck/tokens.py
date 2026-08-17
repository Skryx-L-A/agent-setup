# tokens.py -- the design decisions for THIS deck. Nothing else belongs here.
#
# House rule: a document gets its own layout every time. This file is where that
# decision happens, and layout_pptx.py refuses to build until it has. Work top to
# bottom, replace every value, write the reason on the `# why:` comment, then set
# DESIGN_DECIDED = True. The values below are a WORKING EXAMPLE, not a recommendation.

# --- 1. Slide and purpose --------------------------------------------------------
# 16:9 is 10 x 5.625 INCHES, not 13.33 wide -- a common mistake (confirmed against
# Anthropic's own pptx-generation skill). python-pptx's default template ships a
# 4:3-labelled sldSz that this generator overrides explicitly; never assume the
# library default is 16:9.
SLIDE_WIDTH_IN = 10.0  # why: <…>  16:9 at 10in wide is PowerPoint's own on-screen default
SLIDE_HEIGHT_IN = 5.625  # why: <…>  10 * 9/16

# genres.md #6: a deck is two documents wearing one name. Decide which this is --
# it changes body size and how much text a slide is allowed to carry.
PURPOSE = "support"  # why: <…>  "support" (seen 40s while someone talks) or "leave-behind" (read alone)

MARGIN_MM = dict(
    left=15,  # why: <…>  docrender's own default floor for a slide deck is 12mm
    right=15,  # why: <…>
    top=15,  # why: <…>
    bottom=15,  # why: <…>
)

# --- 2. Fonts --------------------------------------------------------------------
# Same rule as the report template: static instances only (see scripts/make-static-fonts.sh),
# embedded via scripts/officefonts.py. NOTE (tested while building this template):
# LibreOffice Impress does not appear to consume a pptx's embedded fonts on import --
# the mechanism is spec-correct and verified working for the DOCX template, but this
# deck's font embedding could only be confirmed structurally, not by a render
# round-trip. Treat any docrender font-fallback finding on a .pptx with suspicion; see
# reference/antipatterns-office.md.
FONT_TEXT = dict(
    family="CHOOSE-ME",  # why: <…>
    regular="fonts/CHOOSE-ME-Regular.ttf",
    bold="fonts/CHOOSE-ME-Bold.ttf",
)
FONT_DISPLAY = dict(
    family="CHOOSE-ME",  # why: <…>
    regular="fonts/CHOOSE-ME-Regular.ttf",
    bold="fonts/CHOOSE-ME-Bold.ttf",
)

# --- 3. Size scale (points) -------------------------------------------------------
# A "support" deck is seen from four metres and read for seconds -- body text at
# 22pt+ survives the back row; a "leave-behind" reads more like the report template.
SIZE_PT = dict(
    title=40,  # why: <…>  section-opener / cover title
    heading=28,  # why: <…>  per-slide claim, states the point, not just the topic
    body=20,  # why: <…>  bullet text -- at or above the 22pt "back row" floor for PURPOSE=support
    small=12,  # why: <…>  source lines, slide number
)

# --- 4. Ink ------------------------------------------------------------------------
INK = dict(
    text="1A1A1A",  # why: <…>
    soft="6B6560",  # why: <…>
    rule="C9C3BA",  # why: <…>
    accent="7A2F1E",  # why: <…>  ONE job
    background="FFFFFF",  # why: <…>  light background -- C4 dark-page is for screen-only decks, say so if chosen
)

# --- 5. Character budgets ----------------------------------------------------------
# PPTX has no flowing text -- a text box does not reflow onto a new slide the way a
# Typst page does; content that runs long simply overflows the frame, invisibly in
# the source. Chosen strategy (see SKILL.md "PPTX and the overflow problem"): a hard,
# CHECKED budget per placeholder, enforced at build time with a loud failure --
# not autofit/shrink-to-fit, which silently degrades size and readability exactly
# like a substituted font does. A budget forces the content decision back to the
# author instead of hiding it.
BUDGET_CHARS = dict(
    heading=60,  # why: <…>  one line at SIZE_PT.heading in FONT_DISPLAY
    bullet=90,  # why: <…>  one bullet, one line-and-a-bit at SIZE_PT.body
    bullets_per_slide=4,  # why: <…>  a fifth bullet is a second slide, not smaller text
    notes=800,  # why: <…>  the spoken half, for PURPOSE=support -- never squeezed onto the slide itself
)

# --- Gate ----------------------------------------------------------------------
# Set to True only after every value above is yours and every `why:` is filled in.
DESIGN_DECIDED = False
