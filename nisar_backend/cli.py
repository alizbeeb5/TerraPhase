import argparse
import json
from pathlib import Path

from .ingest import ingest
from .product import DIAGONALS, inspect_product
from .render import COLORMAPS
from .verify import verify_scene


def main():
    parser = argparse.ArgumentParser(description="Inspect and prepare NISAR GCOV for a map backend.")
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="Read only metadata; no full-raster loading.")
    inspect.add_argument("source", type=Path)
    verify = commands.add_parser("verify", help="Compare 32 native pixel windows per layer against the source.")
    verify.add_argument("scene_directory", type=Path)
    verify.add_argument("--full", action="store_true", help="Compare every native pixel, in blocks (slower).")
    prepare = commands.add_parser("prepare", help="Create full-resolution COGs, previews and legends.")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("--catalog", type=Path, default=Path("data/catalog"))
    prepare.add_argument("--frequency", choices=("frequencyA", "frequencyB"), default="frequencyA")
    prepare.add_argument("--polarizations", nargs="+", choices=(*DIAGONALS, "all"), default=["HHHH"])
    prepare.add_argument("--vmin", type=float, help="Optional lower display limit in dB")
    prepare.add_argument("--vmax", type=float, help="Optional upper display limit in dB")
    prepare.add_argument("--colormap", choices=COLORMAPS, default="gray")
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            print(json.dumps(inspect_product(args.source), indent=2, allow_nan=False))
        elif args.command == "verify":
            print(json.dumps(verify_scene(args.scene_directory, full=args.full), indent=2, allow_nan=False))
        else:
            if "all" in args.polarizations and args.polarizations != ["all"]:
                parser.error("Use --polarizations all by itself.")
            output = ingest(args.source, args.catalog, args.frequency, tuple(args.polarizations),
                            args.vmin, args.vmax, args.colormap)
            print(f"Prepared scene: {output}")
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()

