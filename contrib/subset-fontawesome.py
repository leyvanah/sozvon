#!/usr/bin/env python3
"""Cut the vendored Font Awesome webfonts down to the glyphs this client uses.

Font Awesome Free 6.7.2 ships ~2000 icons in a 154 KB woff2.  The web client
uses under thirty.  woff2 is already Brotli-compressed, so the server's gzip
does nothing for it, which makes the font the single largest object on a first
load once everything else is compressed.  Subsetting takes it to a few KB.

    python contrib/subset-fontawesome.py --source path/to/pristine/webfonts

--source must point at an *unmodified* Font Awesome 6 Free `webfonts`
directory, not at the one in this repository: that one is already subset, and
re-subsetting a subset can only ever lose glyphs.

The pristine files are in this repository's history, which is more reliable
than re-downloading and cannot drift to another Font Awesome version:

    mkdir /tmp/fa && cd /tmp/fa
    for f in fa-solid-900.ttf fa-regular-400.ttf; do
        git -C <repo> show <commit-before-subsetting>:static/third-party/fontawesome/webfonts/$f > $f
    done

`git log --diff-filter=M -- static/third-party/fontawesome/webfonts/` finds
that commit.

WHEN TO RUN THIS: any time an icon is added to the client, whether as an
`fa-something` class in the markup or as a `content: "\fXXX"` in a stylesheet
— both are scanned.  The subset only contains the glyphs that were in use when
it was generated, so a new icon renders as nothing, or as a box with its own
hex code in it, until this is re-run.  The failure is silent, which is exactly
why this script exists and is documented in CONTRIBUTING.md.

Requires fonttools with woff2 support:  pip install "fonttools[woff]"
"""

import argparse
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
CSS = STATIC / "third-party" / "fontawesome" / "css" / "fontawesome.min.css"
WEBFONTS = STATIC / "third-party" / "fontawesome" / "webfonts"

# The two faces the client actually links; `brands` is vendored but never
# referenced by any page, so it is left alone.
FACES = ["fa-solid-900", "fa-regular-400"]

# Class names that are style selectors rather than icons.
NOT_ICONS = {
    "fa-solid", "fa-regular", "fa-brands", "fa-fw", "fa-spin", "fa-pulse",
    "fa-border", "fa-inverse", "fa-stack", "fa-li", "fa-lg", "fa-2x", "fa-3x",
}


def icons_in_sources():
    """Every fa-* class name mentioned in the client's markup and scripts."""
    found = set()
    for path in sorted(STATIC.glob("*.html")) + sorted(STATIC.glob("*.js")):
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"\bfa-[a-z0-9-]+", text):
            if m.group(0) not in NOT_ICONS:
                found.add(m.group(0))
    return found


def codepoints_in_stylesheets():
    """Codepoints the client's own CSS prints directly.

    Not every icon arrives as a class on an element.  A ::before or ::after
    that sets `content: "\\f054"` and the Font Awesome family draws a glyph
    with no fa-* class anywhere — the participant list's presence dot, its
    mic/camera state, the raised hand, the settings disclosure arrow.  Those
    were invisible to a scan that only reads markup and scripts, so the first
    subset dropped four glyphs that the interface prints on ordinary screens.

    Only the Private Use Area is collected.  A stylesheet may perfectly well
    print an ordinary character that way — `.close-icon` draws "\2715" in
    Arial — and that has nothing to do with this font.  Font Awesome lives
    entirely in the PUA, so the range is the discriminator.

    Only this fork's own sheets are read; the vendored ones under
    third-party/ define the whole face and would defeat the point.
    """
    found = set()
    for path in sorted(STATIC.glob("*.css")):
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r'content:\s*"\\([0-9a-f]{4,6})"', text):
            point = int(m.group(1), 16)
            if 0xE000 <= point <= 0xF8FF:
                found.add(point)
    return found


def codepoints():
    """Map every icon name Font Awesome defines to its codepoint."""
    css = CSS.read_text(encoding="utf-8")
    table = {}
    # .fa-name{--fa:"\f130"}  — aliases share a rule: .fa-a,.fa-b{--fa:"\f0c5"}
    for m in re.finditer(r'((?:\.fa-[a-z0-9-]+,?)+)\{--fa:"\\([0-9a-f]+)"', css):
        for name in re.findall(r"\.(fa-[a-z0-9-]+)", m.group(1)):
            table[name] = int(m.group(2), 16)
    return table


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, type=pathlib.Path,
                    help="pristine Font Awesome 6 Free 'webfonts' directory")
    ap.add_argument("--also", nargs="*", default=[], metavar="fa-name",
                    help="extra icons to keep that are not in the tree yet "
                         "(e.g. ones living on an unmerged branch)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        from fontTools import subset as ft_subset
    except ImportError:
        sys.exit('fonttools is required: pip install "fonttools[woff]"')

    table = codepoints()
    wanted = sorted(icons_in_sources() | set(args.also))

    unknown = [n for n in wanted if n not in table]
    if unknown:
        # A name Font Awesome does not define is almost always a typo in the
        # markup; keeping quiet about it would ship an icon that never renders.
        sys.exit("not Font Awesome icon names: " + ", ".join(unknown))

    from_css = codepoints_in_stylesheets()
    known = set(table.values())
    stray = sorted(p for p in from_css if p not in known)
    if stray:
        # A private-use codepoint that this version of Font Awesome does not
        # define draws nothing but a tofu box, which is the very failure this
        # script exists to prevent — so say so rather than subsetting around
        # it.  Usually it means the icon was renamed between releases.
        sys.exit("printed by a stylesheet, but not in this Font Awesome: " +
                 ", ".join(f"\\{p:04x}" for p in stray))

    points = sorted({table[n] for n in wanted} | from_css)
    print(f"{len(wanted)} icons by class name, {len(from_css)} codepoints "
          f"printed by CSS, {len(points)} distinct codepoints")

    for face in FACES:
        src = args.source / f"{face}.ttf"
        if not src.exists():
            sys.exit(f"missing in --source: {src}")

        for flavor, ext in (("woff2", "woff2"), (None, "ttf")):
            out = WEBFONTS / f"{face}.{ext}"
            before = out.stat().st_size if out.exists() else 0
            if args.dry_run:
                print(f"  would write {out.name}")
                continue

            argv = [
                str(src),
                "--unicodes=" + ",".join(f"U+{p:04x}" for p in points),
                # Icon fonts need no shaping features; dropping them and the
                # unused name records is most of the remaining weight.
                "--layout-features=",
                "--no-hinting",
                "--desubroutinize",
                f"--output-file={out}",
            ]
            if flavor:
                argv.append(f"--flavor={flavor}")
            ft_subset.main(argv)
            after = out.stat().st_size
            print(f"  {out.name:<24}{before/1024:8.1f} KB -> {after/1024:6.1f} KB")


if __name__ == "__main__":
    main()
