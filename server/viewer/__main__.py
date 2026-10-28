"""`python -m viewer` (also the PyInstaller entry point): same as `uv run viewer`."""

from viewer.cli import main  # absolute: PyInstaller runs this file as a top-level script

if __name__ == "__main__":
    main()
