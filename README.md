# nevco

Nevco 4770 hockey scoreboard emulator with the MPCW-7 hand controller.

## Run in a browser

It's a static web app — open `index.html`, or serve the folder:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

Keyboard: **space** = clock on/off, **H** = horn (hold), digits / **Enter** / **Esc**
drive the controller. Fonts are bundled locally in `fonts/`, so it works with
no internet.

## Desktop app (Tauri)

The same files are wrapped as a native desktop app via [Tauri](https://tauri.app)
(Windows `.msi`/`.exe` and macOS `.dmg`).

### Build locally

You need [Node](https://nodejs.org) and the
[Rust toolchain](https://www.rust-lang.org/tools/install), plus Tauri's
platform prerequisites (see https://tauri.app/start/prerequisites/). Tauri is
**not** cross-platform at build time: build the Windows app on Windows and the
macOS app on macOS.

```
npm install
npm run dev      # run the app in a dev window
npm run build    # produce installers in src-tauri/target/release/bundle/
```

The frontend is assembled into `dist/` automatically (`scripts/copy-frontend.mjs`)
before each dev/build run.

### Build both platforms via CI

`.github/workflows/build-desktop.yml` builds macOS (universal) and Windows on
GitHub-hosted runners:

- **Manual:** Actions tab → "Build desktop apps" → *Run workflow*. Installers
  are uploaded as downloadable artifacts on the run page.
- **Release:** push a tag like `v1.0.0` to build all platforms and attach the
  installers to a draft GitHub Release.

```
git tag v1.0.0
git push origin v1.0.0
```

### App icon

The icon in `src-tauri/icons/` is a placeholder. Replace it from any square PNG:

```
npm run tauri icon path/to/your-art.png
```
