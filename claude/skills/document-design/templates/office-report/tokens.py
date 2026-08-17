# tokens.py -- the design decisions for THIS document. Nothing else belongs here.
#
# House rule: a document gets its own layout every time. Content may be carried over
# from an earlier version or a sample; the layout is decided anew. This file is where
# that decision happens, and layout_docx.py refuses to build until it has.
#
# How to use it: work top to bottom, replace every value, and write the reason on the
# `# why:` comment. If you cannot write the reason, you have not decided anything --
# you have kept someone else's default. When every value is yours, set
# DESIGN_DECIDED = True at the bottom.
#
# The values below are a WORKING EXAMPLE of a well-formed set, not a recommendation.
# A second document that ships with these values is a copy, and reads like one.

# --- 1. Page -----------------------------------------------------------------
# DOCX has no notion of a note column the way the Typst template does -- decide
# margins from the delivery path: read on screen, printed single-sided, or bound.
# A symmetric 25/25mm margin on A4 leaves a 160mm text column, which measured
# ~104 characters per line at 11pt on this template's own test build -- the T1
# full-width-body antipattern, and docrender caught it. Word has no note column to
# absorb the difference, so the right margin is widened on its own, the same move
# reference/typesetting.md makes for the Typst template's note column.
PAPER_MM = (210, 297)  # why: A4 -- <…>
MARGIN_MM = dict(
    left=25,  # why: <…>
    right=72,  # why: <…>  narrows the column to ~113mm, measured at ~70 cpl (target 60-72)
    top=25,  # why: <…>
    bottom=22,  # why: <…>  slightly larger than top, keeps the block from sinking
)
# Word places the running head/footer at their own distance-from-edge, independent of
# MARGIN_MM above -- left at the Office default (~12.5mm) they sit closer to the trim
# than docrender's 18mm furniture-margin floor, which is exactly the P8 edge-margins
# antipattern and was caught by it while building this template. Keep both below the
# matching body margin so header/footer never collide with body text.
HEADER_DISTANCE_MM = 18  # why: <…>  meets the 18mm floor, still 7mm clear of top body margin
FOOTER_DISTANCE_MM = 18  # why: <…>  meets the floor, 4mm clear of the bottom body margin

# --- 2. Fonts ------------------------------------------------------------------
# Self-hosted TTF, embedded into the docx itself (scripts/officefonts.py) -- Office
# substitutes a missing font SILENTLY, so an unembedded font is a silent failure on
# the recipient's machine even if it renders correctly here.
#
# MUST be static instances (Regular.ttf, Bold.ttf as separate files), not one variable
# font: Office's embedding and font rendering do not interpolate a variable font's
# weight axis the way Typst does -- confirmed while building this template. Use
# scripts/make-static-fonts.sh on a variable font first.
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

# --- 3. Size scale (points) ----------------------------------------------------
# Print scale, tighter than a screen scale. At most three sizes in the text area of
# a page -- separate the rest by weight, case, position and space.
SIZE_PT = dict(
    small=9,  # why: <…>  captions, footer, running head
    body=11,  # why: <…>
    h3=11,  # why: <…>  same size as body, other voice (weight + case only)
    h2=13,  # why: <…>
    h1=16,  # why: <…>
    title=26,  # why: <…>
)

# --- 4. Ink --------------------------------------------------------------------
# Colour on paper is ink, not light. One colour beyond black, and it does one job.
INK = dict(
    text="1A1A1A",  # why: <…>  near-black, not pure black
    soft="6B6560",  # why: <…>  running head / footer / captions only
    rule="C9C3BA",  # why: <…>  hairlines, table rules
    accent="7A2F1E",  # why: <…>  ONE job: section numbers
)

# --- 5. Detail decisions ---------------------------------------------------------
LINE_SPACING = 1.3  # why: <…>  Word's multiple-of-single-spacing, not a fixed pt leading
JUSTIFY = False  # why: <…>  ragged right unless measure and hyphenation both support it
LANG = "de-DE"  # why: <…>  drives Word's hyphenation and spell-check, not just display
HEADING_NUMBERING = True  # why: <…>  numbered for a document that is referred back to

# --- Gate ----------------------------------------------------------------------
# Set to True only after every value above is yours and every `why:` is filled in.
DESIGN_DECIDED = False
