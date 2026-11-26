# `@agy-daddy/plugin-pet`

MIT clean-room desktop Always-on-Top & PC-Web synchronized companion pet plugin for **Agy-Daddy**.

## Features

- **Native Always-on-Top Transparent Overlay**: Uses `host.overlay` (`ui:desktop-overlay`) on macOS (AppKit `NSPanel`), Windows (WPF Layered Topmost), and Linux (GTK3 RGBA) with click-through outside hit bounds and zero WebView overhead.
- **PC-Web Synchronized Floating Pet**: Shares the exact same `src/shared/*` vector rigs and `Path2D` Canvas stage inside `agy-daddy-plugin-web`.
- **12 Built-in MIT Original Tribute Themes**: `daddy-orb`, `abyssal-whale`, `sunny-sponge`, `nimble-mouse`, `aegis-visor`, `cyber-neko`, `arcade-chomp`, `astro-shiba`, `vapor-dolphin`, `cli-phantom`, `graffiti-cub`, and `arcane-cat`.
- **6-Layer Sandboxed Local Import**: Safely import `.agypet` / `.tar` / `.json` custom theme packs without executable code or `fs:user-files`.
- **4D Session Watch Filters & Live TPS Linkage**: Supports follow-current-session, exclude-current-session, project whitelist, and group whitelist while tracking live tokens/s and approval/reply alerts.
