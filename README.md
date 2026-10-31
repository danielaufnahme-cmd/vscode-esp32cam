# ESP32 Camera Dev (VSCodium extension)

Live ESP32-S3 camera preview next to the editor, plus Run / Upload / Stop for MicroPython over USB.

## Features

- **Camera tab**: live frames from the board's second USB port, with snapshots.
- **Run on ESP32** (`F5` / `▶`), **Stop** (`Shift+F5` / `■`), **Upload**, **REPL**, **Reset** and **List files** for MicroPython.
- **Devices view**: shows the boards that are plugged in.

## Requirements

The extension switches on when the open folder contains `tools/usb_bridge.py`. It runs these helper scripts from your project with the project's own `.venv/bin/python`:

- `tools/usb_bridge.py`: reads camera frames from the board's second USB port
- `tools/board.py`: runs, uploads and stops scripts over the REPL port (uses `mpremote`)

## Install

Zip the folder as a `.vsix` (for example with `npx @vscode/vsce package`) and run:

```bash
codium --install-extension esp32cam-0.2.0.vsix
```

Then reload VSCodium (`Ctrl+Shift+P` → **Developer: Reload Window**).

## License

MIT. Made with the help of AI (Claude Code).
